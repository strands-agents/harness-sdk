"""
Comprehensive integration tests for structured output passed into the agent functionality.
"""

import pytest
from pydantic import BaseModel, Field, field_validator

from strands import Agent
from strands.tools import tool

# ========== Pydantic Models from notebook ==========


class MathResult(BaseModel):
    """Math operation result."""

    operation: str = Field(description="the performed operation")
    result: int = Field(description="the result of the operation")


class UserProfile(BaseModel):
    """Basic user profile model."""

    name: str
    age: int
    occupation: str
    active: bool = True


class Address(BaseModel):
    """Address information."""

    street: str
    city: str
    state: str
    zip_code: str


class Contact(BaseModel):
    """Contact information."""

    email: str
    phone: str | None = None
    preferred_method: str = "email"


class Employee(BaseModel):
    """Complex nested employee model."""

    name: str
    employee_id: int
    department: str
    address: Address
    contact: Contact
    skills: list[str]
    hire_date: str
    salary_range: str


class ProductReview(BaseModel):
    """Product review analysis."""

    product_name: str
    rating: int = Field(ge=1, le=5, description="Rating from 1-5 stars")
    sentiment: str = Field(pattern="^(positive|negative|neutral)$")
    key_points: list[str]
    would_recommend: bool


class WeatherForecast(BaseModel):
    """Weather forecast data."""

    location: str
    temperature: int
    condition: str
    humidity: int
    wind_speed: int
    forecast_date: str


class TaskList(BaseModel):
    """Task management structure."""

    project_name: str
    tasks: list[str]
    priority: str = Field(pattern="^(high|medium|low)$")
    due_date: str
    estimated_hours: int


class Person(BaseModel):
    """A person's basic information."""

    name: str = Field(description="Full name")
    age: int = Field(description="Age in years", ge=0, le=150)


class Company(BaseModel):
    """A company or organization."""

    name: str = Field(description="Company name")
    address: Address = Field(description="Company address")
    employees: list[Person] = Field(description="list of persons")


class Task(BaseModel):
    """A task or todo item."""

    title: str = Field(description="Task title")
    description: str = Field(description="Detailed description")
    priority: str = Field(description="Priority level: low, medium, high")
    completed: bool = Field(description="Whether task is completed", default=False)


class NameWithValidation(BaseModel):
    """Name model with validation that forces retry."""

    first_name: str

    @field_validator("first_name")
    @classmethod
    def validate_first_name(cls, value: str) -> str:
        if not value.endswith("abc"):
            raise ValueError("You must append 'abc' to the end of my name")
        return value


# ========== Tool Definitions ==========


@tool
def calculator(operation: str, a: float, b: float) -> float:
    """Simple calculator tool for testing.

    Args:
        operation: The operation to perform. One of: add, subtract, multiply, divide, power
        a: The first number
        b: The second number
    """
    op = operation.lower().strip()
    if op in ("add", "+"):
        return a + b
    elif op in ("subtract", "-", "sub"):
        return a - b
    elif op in ("multiply", "*", "mul"):
        return a * b
    elif op in ("divide", "/", "div"):
        return a / b if b != 0 else 0
    elif op in ("power", "**", "pow"):
        return a**b
    else:
        return 0


# ========== Test Classes ==========


class TestBasicStructuredOutput:
    """Test basic structured output functionality."""

    def test_regular_call_without_structured_output(self):
        """Test that regular calls work without structured output."""
        agent = Agent()
        result = agent("What can you do for me?")

        assert result.structured_output is None
        assert agent._default_structured_output_model is None

    def test_simple_structured_output(self):
        """Test basic structured output with UserProfile."""
        agent = Agent()

        result = agent(
            "Create a profile for John Doe who is a 25 year old dentist", structured_output_model=UserProfile
        )

        assert result.structured_output is not None
        assert isinstance(result.structured_output, UserProfile)
        assert result.structured_output.name == "John Doe"
        assert result.structured_output.age == 25
        assert result.structured_output.occupation.lower() == "dentist"

    def test_follow_up_without_structured_output(self):
        """Test that follow-up calls work without structured output."""
        agent = Agent()

        # First call with structured output
        result1 = agent(
            "Create a profile for John Doe who is a 25 year old dentist", structured_output_model=UserProfile
        )
        assert result1.structured_output is not None

        # Second call without structured output
        result2 = agent("what did you just do?")
        assert result2.structured_output is None


class TestToolUsage:
    """Test structured output with tool usage."""

    def test_tool_use_without_structured_output(self):
        """Test tool usage without structured output."""
        agent = Agent(tools=[calculator])

        result = agent("What is 2 + 2? Use the calculator tool.")

        assert result.structured_output is None
        # Check that tool was called (in metrics)
        assert result.metrics.tool_metrics is not None
        assert len(result.metrics.tool_metrics) > 0

    def test_tool_use_with_structured_output(self):
        """Test tool usage with structured output."""
        agent = Agent(tools=[calculator])

        result = agent("Calculate 2 + 2 using the calculator tool", structured_output_model=MathResult)

        assert result.structured_output is not None
        assert isinstance(result.structured_output, MathResult)
        assert result.structured_output.result == 4
        # Check that tool was called
        assert result.metrics.tool_metrics is not None
        assert len(result.metrics.tool_metrics) > 0


class TestAsyncOperations:
    """Test async operations with structured output."""

    @pytest.mark.asyncio
    async def test_async_structured_output(self):
        """Test async invocation with structured output."""
        agent = Agent()

        result = await agent.invoke_async(
            """
            Analyze this product review:
            "This wireless mouse is fantastic! Great battery life, smooth tracking, 
            and the ergonomic design is perfect for long work sessions. The price 
            is reasonable too. I'd definitely buy it again and recommend it to others.
            Rating: 5 stars"
            """,
            structured_output_model=ProductReview,
        )

        assert result.structured_output is not None
        assert isinstance(result.structured_output, ProductReview)
        assert result.structured_output.rating == 5
        assert result.structured_output.sentiment == "positive"
        assert result.structured_output.would_recommend is True


class TestStreamingOperations:
    """Test streaming with structured output."""

    @pytest.mark.asyncio
    async def test_streaming_with_structured_output(self):
        """Test streaming with structured output."""
        agent = Agent()

        result_found = False
        structured_output_found = False

        async for event in agent.stream_async(
            "Generate a weather forecast for Seattle: 68°F, partly cloudy, 55% humidity, 8 mph winds, for tomorrow",
            structured_output_model=WeatherForecast,
        ):
            if "result" in event:
                result_found = True
                if event["result"].structured_output:
                    structured_output_found = True
                    forecast = event["result"].structured_output
                    assert isinstance(forecast, WeatherForecast)
                    assert forecast.location == "Seattle"

        assert result_found, "No result event found in stream"
        assert structured_output_found, "No structured output found in stream result"


class TestMultipleInvocations:
    """Test multiple invocations with different structured output models."""

    def test_multiple_invocations_different_models(self):
        """Test using different structured output models in consecutive calls."""
        agent = Agent()

        # First invocation with Person model
        person_result = agent("Extract person: John Doe, 35, john@test.com", structured_output_model=Person)
        assert person_result.structured_output is not None
        assert isinstance(person_result.structured_output, Person)
        assert person_result.structured_output.name == "John Doe"
        assert person_result.structured_output.age == 35

        # Second invocation with Task model
        task_result = agent("Create task: Review code, high priority, completed", structured_output_model=Task)
        assert task_result.structured_output is not None
        assert isinstance(task_result.structured_output, Task)
        assert task_result.structured_output.title == "Review code"
        assert task_result.structured_output.priority == "high"
        assert task_result.structured_output.completed is True

        # Third invocation without structured output
        normal_result = agent("What tasks do we have?")
        assert normal_result.structured_output is None


class TestAgentInitialization:
    """Test agent initialization with default structured output model."""

    def test_agent_with_default_structured_output(self):
        """Test agent initialized with default structured output model."""
        agent = Agent(structured_output_model=UserProfile)

        result = agent("Create a profile for John Doe who is a 25 year old dentist")

        assert result.structured_output is not None
        assert isinstance(result.structured_output, UserProfile)
        assert result.structured_output.name == "John Doe"
        assert result.structured_output.age == 25
        assert result.structured_output.occupation.lower() == "dentist"


class TestValidationRetry:
    """Test validation with retry logic."""

    def test_validation_forces_retry(self):
        """Test that validation errors force the model to retry."""
        agent = Agent()

        result = agent("What's Aaron's name?", structured_output_model=NameWithValidation)

        assert result.structured_output is not None
        assert isinstance(result.structured_output, NameWithValidation)
        # The model should have learned to append 'abc' after validation failure
        assert result.structured_output.first_name.endswith("abc")
        assert "Aaron" in result.structured_output.first_name or "aaron" in result.structured_output.first_name.lower()
