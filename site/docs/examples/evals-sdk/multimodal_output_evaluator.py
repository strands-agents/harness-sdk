import asyncio
import datetime

from strands import Agent

from strands_evals import Case, Experiment
from strands_evals.evaluators import (
    MultimodalCorrectnessEvaluator,
    MultimodalOutputEvaluator,
)
from strands_evals.evaluators.prompt_templates.multimodal import (
    OVERALL_QUALITY_RUBRIC_V0,
)
from strands_evals.types import ImageData, MultimodalInput


# Replace with a path to your own image before running the example.
# `MultimodalInput.media` accepts an `ImageData` instance, a list of `ImageData`,
# or a `str` (file path, base64 string, data URL, or HTTP(S) URL). To pass raw
# bytes or a PIL Image, wrap them in `ImageData(source=...)`.
SAMPLE_IMAGE_PATH = "/path/to/your/chart.png"


async def multimodal_output_evaluator_example():
    """
    Demonstrates using MultimodalOutputEvaluator to judge multimodal agent outputs.

    This example:
    1. Defines a task function that asks a multimodal agent to describe an image
    2. Creates multimodal test cases (reference-free and reference-based)
    3. Creates a MultimodalOutputEvaluator (custom rubric) and a
       MultimodalCorrectnessEvaluator (built-in rubric)
    4. Creates an experiment with the test cases and evaluators
    5. Runs evaluations and displays the report

    Returns:
        EvaluationReport: The evaluation results
    """

    # 1. Define a task function that invokes a multimodal agent.
    async def get_response(case: Case) -> str:
        agent = Agent(
            system_prompt="You are a helpful multimodal assistant. Describe what is visible in the image.",
            callback_handler=None,
        )
        multimodal_input = case.input
        if not isinstance(multimodal_input, MultimodalInput):
            raise TypeError("This example expects MultimodalInput cases.")

        # Normalize media to an ImageData instance.
        # MultimodalInput.media can be a str, ImageData, or list[ImageData];
        # this example assumes a single str or ImageData.
        media = multimodal_input.media
        image = media if isinstance(media, ImageData) else ImageData(source=media)
        prompt = [
            {"image": {"format": image.format or "png", "source": {"bytes": image.to_bytes()}}},
            {"text": multimodal_input.instruction},
        ]
        response = await agent.invoke_async(prompt)
        return str(response)

    # 2. Create multimodal test cases.
    reference_free_case = Case(
        name="chart-overview",
        input=MultimodalInput(
            media=SAMPLE_IMAGE_PATH,
            instruction="What kind of chart is shown and what does it represent?",
        ),
        metadata={"category": "chart-qa", "mode": "reference-free"},
    )

    reference_based_case = Case(
        name="chart-type",
        input=MultimodalInput(
            media=SAMPLE_IMAGE_PATH,
            instruction="What type of chart is this? Answer in one word.",
        ),
        expected_output="bar chart",
        metadata={"category": "chart-qa", "mode": "reference-based"},
    )

    # 3. Create evaluators.
    #    - Custom rubric via the base MultimodalOutputEvaluator
    overall_quality_judge = MultimodalOutputEvaluator(
        rubric=OVERALL_QUALITY_RUBRIC_V0,
        include_inputs=True,
    )
    #    - Built-in rubric via the matching subclass
    correctness_judge = MultimodalCorrectnessEvaluator()

    # 4. Create an experiment.
    experiment = Experiment(
        cases=[reference_free_case, reference_based_case],
        evaluators=[overall_quality_judge, correctness_judge],
    )

    # 4.5. (Optional) Save the experiment for later reloading.
    experiment.to_file("multimodal_output_evaluator_experiment.json")

    # 5. Run evaluations. The experiment returns a single combined report
    #    across all evaluators.
    report = await experiment.run_evaluations_async(get_response)
    return report


if __name__ == "__main__":
    # Run as a module: python -m examples.evals-sdk.multimodal_output_evaluator
    start_time = datetime.datetime.now()
    report = asyncio.run(multimodal_output_evaluator_example())
    end_time = datetime.datetime.now()
    print("Elapsed:", end_time - start_time)

    report.to_file("multimodal_output_evaluator_report.json")
    report.run_display(include_actual_output=True)
