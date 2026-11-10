"""Tests for InterventionRegistry."""

import unittest.mock

import pytest

from strands.hooks import HookRegistry
from strands.hooks.events import (
    AfterModelCallEvent,
    AfterToolCallEvent,
    BeforeInvocationEvent,
    BeforeModelCallEvent,
    BeforeToolCallEvent,
)
from strands.interrupt import Interrupt, _InterruptState
from strands.interventions.actions import (
    Confirm,
    Deny,
    Guide,
    Proceed,
    Transform,
)
from strands.interventions.handler import InterventionHandler
from strands.interventions.registry import InterventionRegistry


class DenyHandler(InterventionHandler):
    name = "deny-handler"

    async def before_tool_call(self, event):
        return Deny(reason="not authorized")


class GuideHandler(InterventionHandler):
    name = "guide-handler"

    async def before_tool_call(self, event):
        return Guide(feedback="add more context")


class ConfirmHandler(InterventionHandler):
    name = "confirm-handler"

    async def before_tool_call(self, event):
        return Confirm(prompt="approve this action?")


class ProceedHandler(InterventionHandler):
    name = "proceed-handler"

    async def before_tool_call(self, event):
        return Proceed(reason="all good")


class ThrowingHandler(InterventionHandler):
    name = "throwing-handler"

    @property
    def on_error(self):
        return "throw"

    async def before_tool_call(self, event):
        raise RuntimeError("handler crashed")


class ThrowingProceedHandler(InterventionHandler):
    name = "throwing-proceed"

    @property
    def on_error(self):
        return "proceed"

    async def before_tool_call(self, event):
        raise RuntimeError("handler crashed")


class ThrowingDenyHandler(InterventionHandler):
    name = "throwing-deny"

    @property
    def on_error(self):
        return "deny"

    async def before_tool_call(self, event):
        raise RuntimeError("handler crashed")


class AsyncDenyHandler(InterventionHandler):
    name = "async-deny"

    async def before_tool_call(self, event):
        return Deny(reason="async denial")


class ModelGuideHandler(InterventionHandler):
    name = "model-guide"

    async def after_model_call(self, event):
        return Guide(feedback="be more specific")


@pytest.fixture
def hook_registry():
    return HookRegistry()


@pytest.fixture
def agent():
    instance = unittest.mock.Mock()
    instance._interrupt_state = _InterruptState()
    instance.messages = []
    return instance


def make_before_invocation_event(agent):
    return BeforeInvocationEvent(agent=agent, invocation_state={})


def make_before_tool_call_event(agent):
    return BeforeToolCallEvent(
        agent=agent,
        selected_tool=None,
        tool_use={"toolUseId": "id-1", "name": "testTool", "input": {}},
        invocation_state={},
    )


def make_before_model_call_event(agent):
    return BeforeModelCallEvent(agent=agent, invocation_state={})


def make_after_model_call_event(agent):
    return AfterModelCallEvent(
        agent=agent,
        invocation_state={},
        stop_response=AfterModelCallEvent.ModelStopResponse(
            stop_reason="end_turn",
            message={"role": "assistant", "content": [{"text": "response"}]},
        ),
    )


class TestConstructor:
    def test_rejects_duplicate_handler_names(self, hook_registry):
        with pytest.raises(ValueError, match="Duplicate intervention handler name: 'deny-handler'"):
            InterventionRegistry([DenyHandler(), DenyHandler()], hook_registry)

    def test_accepts_unique_names(self, hook_registry):
        InterventionRegistry([DenyHandler(), GuideHandler()], hook_registry)


class TestHookRegistration:
    @pytest.mark.asyncio
    async def test_only_registers_hooks_for_overridden_methods(self, hook_registry, agent):
        InterventionRegistry([DenyHandler()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool == "DENIED: not authorized"

        # afterModelCall should not be registered
        model_event = make_after_model_call_event(agent)
        await hook_registry.invoke_callbacks_async(model_event)
        assert model_event.retry is False


class TestDispatchOrdering:
    @pytest.mark.asyncio
    async def test_calls_handlers_in_registration_order(self, hook_registry, agent):
        call_order = []

        class First(InterventionHandler):
            name = "first"

            async def before_tool_call(self, event):
                call_order.append("first")
                return Proceed()

        class Second(InterventionHandler):
            name = "second"

            async def before_tool_call(self, event):
                call_order.append("second")
                return Proceed()

        InterventionRegistry([First(), Second()], hook_registry)

        await hook_registry.invoke_callbacks_async(make_before_tool_call_event(agent))
        assert call_order == ["first", "second"]

    @pytest.mark.asyncio
    async def test_skips_handlers_that_do_not_override_method(self, hook_registry, agent):
        call_order = []

        class ToolHandler(InterventionHandler):
            name = "tool"

            async def before_tool_call(self, event):
                call_order.append("tool")
                return Proceed()

        class ModelHandler(InterventionHandler):
            name = "model"

            async def after_model_call(self, event):
                call_order.append("model")
                return Proceed()

        InterventionRegistry([ToolHandler(), ModelHandler()], hook_registry)

        await hook_registry.invoke_callbacks_async(make_before_tool_call_event(agent))
        assert call_order == ["tool"]


class TestDeny:
    @pytest.mark.asyncio
    async def test_sets_cancel_on_before_tool_call(self, hook_registry, agent):
        InterventionRegistry([DenyHandler()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool == "DENIED: not authorized"

    @pytest.mark.asyncio
    async def test_short_circuits_later_handlers(self, hook_registry, agent):
        later_called = False

        class LaterHandler(InterventionHandler):
            name = "later"

            async def before_tool_call(self, event):
                nonlocal later_called
                later_called = True
                return Proceed()

        InterventionRegistry([DenyHandler(), LaterHandler()], hook_registry)

        await hook_registry.invoke_callbacks_async(make_before_tool_call_event(agent))
        assert not later_called

    @pytest.mark.asyncio
    async def test_sets_cancel_on_before_invocation(self, hook_registry, agent):
        class InvocationDeny(InterventionHandler):
            name = "invocation-deny"

            async def before_invocation(self, event):
                return Deny(reason="unauthorized user")

        InterventionRegistry([InvocationDeny()], hook_registry)

        event = make_before_invocation_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel == "DENIED: unauthorized user"

    @pytest.mark.asyncio
    async def test_sets_cancel_on_before_model_call(self, hook_registry, agent):
        class ModelDeny(InterventionHandler):
            name = "model-deny"

            async def before_model_call(self, event):
                return Deny(reason="prompt injection detected")

        InterventionRegistry([ModelDeny()], hook_registry)

        event = make_before_model_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel == "DENIED: prompt injection detected"


class TestGuide:
    @pytest.mark.asyncio
    async def test_sets_cancel_with_guidance_on_before_tool_call(self, hook_registry, agent):
        InterventionRegistry([GuideHandler()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool == "GUIDANCE: [guide-handler] add more context"

    @pytest.mark.asyncio
    async def test_accumulates_feedback_from_multiple_handlers(self, hook_registry, agent):
        class SecondGuide(InterventionHandler):
            name = "second-guide"

            async def before_tool_call(self, event):
                return Guide(feedback="also check permissions")

        InterventionRegistry([GuideHandler(), SecondGuide()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool == "GUIDANCE: [guide-handler] add more context\n[second-guide] also check permissions"

    @pytest.mark.asyncio
    async def test_sets_retry_and_injects_guidance_on_after_model_call(self, hook_registry, agent):
        InterventionRegistry([ModelGuideHandler()], hook_registry)

        event = make_after_model_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)

        assert event.retry is True
        assert agent.messages == [
            {"role": "user", "content": [{"text": "[model-guide] be more specific"}], "tracking_id": unittest.mock.ANY}
        ]


class TestConfirm:
    @pytest.mark.asyncio
    async def test_pauses_agent_when_no_response(self, hook_registry, agent):
        InterventionRegistry([ConfirmHandler()], hook_registry)

        event = make_before_tool_call_event(agent)
        _, interrupts = await hook_registry.invoke_callbacks_async(event)
        assert len(interrupts) == 1
        assert interrupts[0].name == "confirm-handler"

    @pytest.mark.asyncio
    async def test_short_circuits_later_handlers(self, hook_registry, agent):
        later_called = False

        class LaterHandler(InterventionHandler):
            name = "later"

            async def before_tool_call(self, event):
                nonlocal later_called
                later_called = True
                return Proceed()

        InterventionRegistry([ConfirmHandler(), LaterHandler()], hook_registry)

        _, interrupts = await hook_registry.invoke_callbacks_async(make_before_tool_call_event(agent))
        assert len(interrupts) == 1
        assert not later_called

    @pytest.mark.asyncio
    async def test_approve_on_resume(self, hook_registry, agent):
        # Preload interrupt response
        tool_use_id = "id-1"
        import uuid

        interrupt_id = f"v1:before_tool_call:{tool_use_id}:{uuid.uuid5(uuid.NAMESPACE_OID, 'confirm-handler')}"
        agent._interrupt_state.interrupts[interrupt_id] = Interrupt(
            id=interrupt_id, name="confirm-handler", response="yes"
        )

        InterventionRegistry([ConfirmHandler()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool is False

    @pytest.mark.asyncio
    async def test_deny_on_resume(self, hook_registry, agent):
        import uuid

        tool_use_id = "id-1"
        interrupt_id = f"v1:before_tool_call:{tool_use_id}:{uuid.uuid5(uuid.NAMESPACE_OID, 'confirm-handler')}"
        agent._interrupt_state.interrupts[interrupt_id] = Interrupt(
            id=interrupt_id, name="confirm-handler", response="no"
        )

        InterventionRegistry([ConfirmHandler()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool == "CONFIRMATION_FAILED: approve this action?"

    @pytest.mark.asyncio
    async def test_preemptive_response_approves(self, hook_registry, agent):
        class InlineConfirm(InterventionHandler):
            name = "inline-confirm"

            async def before_tool_call(self, event):
                return Confirm(prompt="approve?", response="yes")

        InterventionRegistry([InlineConfirm()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool is False

    @pytest.mark.asyncio
    async def test_preemptive_response_denies(self, hook_registry, agent):
        class InlineConfirm(InterventionHandler):
            name = "inline-confirm"

            async def before_tool_call(self, event):
                return Confirm(prompt="approve?", response="no")

        InterventionRegistry([InlineConfirm()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool == "CONFIRMATION_FAILED: approve?"

    @pytest.mark.asyncio
    async def test_custom_evaluate(self, hook_registry, agent):
        class OtpHandler(InterventionHandler):
            name = "otp-handler"

            async def before_tool_call(self, event):
                return Confirm(prompt="Enter OTP:", response="123456", evaluate=lambda r: r == "123456")

        InterventionRegistry([OtpHandler()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool is False


class TestTransform:
    @pytest.mark.asyncio
    async def test_calls_apply_function(self, hook_registry, agent):
        applied = []

        class TransformHandler(InterventionHandler):
            name = "transform-handler"

            async def before_tool_call(self, event):
                return Transform(apply=lambda e: applied.append(e), reason="sanitized")

        InterventionRegistry([TransformHandler()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert applied == [event]

    @pytest.mark.asyncio
    async def test_later_handlers_see_transformed_state(self, hook_registry, agent):
        observed = []

        class Transformer(InterventionHandler):
            name = "transformer"

            async def before_tool_call(self, event):
                def apply_fn(e):
                    e.cancel_tool = "transformed"

                return Transform(apply=apply_fn)

        class Observer(InterventionHandler):
            name = "observer"

            async def before_tool_call(self, event):
                observed.append(event.cancel_tool)
                return Proceed()

        InterventionRegistry([Transformer(), Observer()], hook_registry)

        await hook_registry.invoke_callbacks_async(make_before_tool_call_event(agent))
        assert observed == ["transformed"]


class TestProceed:
    @pytest.mark.asyncio
    async def test_does_not_mutate_event(self, hook_registry, agent):
        InterventionRegistry([ProceedHandler()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool is False


class TestErrorHandling:
    @pytest.mark.asyncio
    async def test_on_error_throw_rethrows(self, hook_registry, agent):
        InterventionRegistry([ThrowingHandler(), ProceedHandler()], hook_registry)

        with pytest.raises(RuntimeError, match="handler crashed"):
            await hook_registry.invoke_callbacks_async(make_before_tool_call_event(agent))

    @pytest.mark.asyncio
    async def test_on_error_proceed_skips(self, hook_registry, agent):
        InterventionRegistry([ThrowingProceedHandler(), ProceedHandler()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool is False

    @pytest.mark.asyncio
    async def test_on_error_deny_applies_deny(self, hook_registry, agent):
        later_called = False

        class LaterHandler(InterventionHandler):
            name = "later"

            async def before_tool_call(self, event):
                nonlocal later_called
                later_called = True
                return Proceed()

        InterventionRegistry([ThrowingDenyHandler(), LaterHandler()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)

        assert event.cancel_tool == "DENIED: Handler threw: handler crashed"
        assert not later_called


class TestConflictResolution:
    @pytest.mark.asyncio
    async def test_deny_wins_over_guide(self, hook_registry, agent):
        InterventionRegistry([GuideHandler(), DenyHandler()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool == "DENIED: not authorized"

    @pytest.mark.asyncio
    async def test_deny_short_circuits_before_guide(self, hook_registry, agent):
        InterventionRegistry([DenyHandler(), GuideHandler()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool == "DENIED: not authorized"

    @pytest.mark.asyncio
    async def test_confirm_short_circuits_before_guide(self, hook_registry, agent):
        InterventionRegistry([ConfirmHandler(), GuideHandler()], hook_registry)

        _, interrupts = await hook_registry.invoke_callbacks_async(make_before_tool_call_event(agent))
        assert len(interrupts) == 1


class TestEdgeCases:
    @pytest.mark.asyncio
    async def test_guide_on_before_model_call_injects_user_message(self, hook_registry, agent):
        class ModelGuide(InterventionHandler):
            name = "model-guide"

            async def before_model_call(self, event):
                return Guide(feedback="check your sources")

        InterventionRegistry([ModelGuide()], hook_registry)

        event = make_before_model_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)

        assert event.cancel is False
        assert agent.messages == [
            {
                "role": "user",
                "content": [{"text": "[model-guide] check your sources"}],
                "tracking_id": unittest.mock.ANY,
            }
        ]

    @pytest.mark.asyncio
    async def test_transform_apply_error_handled_via_on_error(self, hook_registry, agent):
        class BadTransform(InterventionHandler):
            name = "bad-transform"

            @property
            def on_error(self):
                return "proceed"

            async def before_tool_call(self, event):
                return Transform(apply=lambda e: (_ for _ in ()).throw(RuntimeError("apply boom")))

        class AfterTransform(InterventionHandler):
            name = "after-transform"

            async def before_tool_call(self, event):
                return Proceed(reason="still running")

        InterventionRegistry([BadTransform(), AfterTransform()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool is False

    @pytest.mark.asyncio
    async def test_transform_apply_error_with_throw_propagates(self, hook_registry, agent):
        class BadTransform(InterventionHandler):
            name = "bad-transform"

            async def before_tool_call(self, event):
                def bad_apply(e):
                    raise RuntimeError("apply boom")

                return Transform(apply=bad_apply)

        InterventionRegistry([BadTransform()], hook_registry)

        with pytest.raises(RuntimeError, match="apply boom"):
            await hook_registry.invoke_callbacks_async(make_before_tool_call_event(agent))


class TestConfirmFalsyResponse:
    @pytest.mark.asyncio
    async def test_preemptive_response_false_denies(self, hook_registry, agent):
        """response=False is falsy but defined — must be passed and evaluated as denial."""

        class InlineConfirm(InterventionHandler):
            name = "inline-confirm"

            async def before_tool_call(self, event):
                return Confirm(prompt="approve?", response=False)

        InterventionRegistry([InlineConfirm()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool == "CONFIRMATION_FAILED: approve?"

    @pytest.mark.asyncio
    async def test_approved_confirm_does_not_short_circuit_later_handlers(self, hook_registry, agent):
        """When confirm is approved, later handlers must still run."""
        import uuid

        tool_use_id = "id-1"
        interrupt_id = f"v1:before_tool_call:{tool_use_id}:{uuid.uuid5(uuid.NAMESPACE_OID, 'confirm-handler')}"
        agent._interrupt_state.interrupts[interrupt_id] = Interrupt(
            id=interrupt_id, name="confirm-handler", response="yes"
        )

        later_called = False

        class LaterHandler(InterventionHandler):
            name = "later"

            async def before_tool_call(self, event):
                nonlocal later_called
                later_called = True
                return Proceed()

        InterventionRegistry([ConfirmHandler(), LaterHandler()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool is False
        assert later_called

    @pytest.mark.asyncio
    async def test_denied_confirm_on_resume_short_circuits_later_handlers(self, hook_registry, agent):
        """When confirm is denied on resume, later handlers must not run."""
        import uuid

        tool_use_id = "id-1"
        interrupt_id = f"v1:before_tool_call:{tool_use_id}:{uuid.uuid5(uuid.NAMESPACE_OID, 'confirm-handler')}"
        agent._interrupt_state.interrupts[interrupt_id] = Interrupt(
            id=interrupt_id, name="confirm-handler", response="no"
        )

        later_called = False

        class LaterHandler(InterventionHandler):
            name = "later"

            async def before_tool_call(self, event):
                nonlocal later_called
                later_called = True
                return Proceed()

        InterventionRegistry([ConfirmHandler(), LaterHandler()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool == "CONFIRMATION_FAILED: approve this action?"
        assert not later_called


class TestInterruptPropagation:
    @pytest.mark.asyncio
    async def test_interrupt_propagates_with_on_error_proceed(self, hook_registry, agent):
        """InterruptException must propagate even when onError=proceed."""

        class ConfirmProceedOnError(InterventionHandler):
            name = "confirm-proceed"

            @property
            def on_error(self):
                return "proceed"

            async def before_tool_call(self, event):
                return Confirm(prompt="approve?")

        InterventionRegistry([ConfirmProceedOnError()], hook_registry)

        event = make_before_tool_call_event(agent)
        _, interrupts = await hook_registry.invoke_callbacks_async(event)
        assert len(interrupts) == 1
        assert interrupts[0].name == "confirm-proceed"

    @pytest.mark.asyncio
    async def test_interrupt_propagates_with_on_error_deny(self, hook_registry, agent):
        """InterruptException must propagate even when onError=deny."""

        class ConfirmDenyOnError(InterventionHandler):
            name = "confirm-deny"

            @property
            def on_error(self):
                return "deny"

            async def before_tool_call(self, event):
                return Confirm(prompt="approve?")

        InterventionRegistry([ConfirmDenyOnError()], hook_registry)

        event = make_before_tool_call_event(agent)
        _, interrupts = await hook_registry.invoke_callbacks_async(event)
        assert len(interrupts) == 1
        assert interrupts[0].name == "confirm-deny"

    @pytest.mark.parametrize("on_error_mode", ["proceed", "deny"])
    @pytest.mark.asyncio
    async def test_handler_raised_interrupt_propagates_regardless_of_on_error(
        self, hook_registry, agent, on_error_mode
    ):
        """A handler calling event.interrupt() directly pauses the agent under any on_error (#4371)."""

        class DirectInterruptHandler(InterventionHandler):
            name = "direct-interrupt"

            @property
            def on_error(self):
                return on_error_mode

            async def before_tool_call(self, event):
                response = event.interrupt("approval", reason="approve?")
                return Proceed() if response == "yes" else Deny(reason="not approved")

        InterventionRegistry([DirectInterruptHandler()], hook_registry)

        event = make_before_tool_call_event(agent)
        _, interrupts = await hook_registry.invoke_callbacks_async(event)

        assert len(interrupts) == 1
        assert interrupts[0].name == "approval"
        assert event.cancel_tool is False


class TestTransformAfterModelCall:
    @pytest.mark.asyncio
    async def test_transform_on_after_model_call(self, hook_registry, agent):
        """Transform apply function is called on AfterModelCallEvent."""
        applied = []

        class ModelTransform(InterventionHandler):
            name = "model-transform"

            async def after_model_call(self, event):
                return Transform(apply=lambda e: applied.append(e), reason="redacted output")

        InterventionRegistry([ModelTransform()], hook_registry)

        event = make_after_model_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert applied == [event]


class TestUnsupportedActionWarning:
    @pytest.mark.asyncio
    async def test_confirm_on_before_invocation_warns(self, hook_registry, agent, caplog):
        """Confirm on beforeInvocation has no effect and logs a warning."""

        class ConfirmOnInvocation(InterventionHandler):
            name = "confirm-invocation"

            async def before_invocation(self, event):
                return Confirm(prompt="test")

        InterventionRegistry([ConfirmOnInvocation()], hook_registry)

        import logging

        with caplog.at_level(logging.WARNING, logger="strands.interventions.registry"):
            event = make_before_invocation_event(agent)
            await hook_registry.invoke_callbacks_async(event)

        assert any("has no effect" in record.message for record in caplog.records)

    @pytest.mark.asyncio
    async def test_deny_on_after_tool_call_warns(self, hook_registry, agent, caplog):
        """Deny on afterToolCall has no effect and logs a warning."""

        class DenyAfterTool(InterventionHandler):
            name = "deny-after-tool"

            async def after_tool_call(self, event):
                return Deny(reason="too late")

        InterventionRegistry([DenyAfterTool()], hook_registry)

        import logging

        with caplog.at_level(logging.WARNING, logger="strands.interventions.registry"):
            event = AfterToolCallEvent(
                agent=agent,
                selected_tool=None,
                tool_use={"toolUseId": "id-1", "name": "testTool", "input": {}},
                invocation_state={},
                result={"content": [{"text": "ok"}], "status": "success"},
            )
            await hook_registry.invoke_callbacks_async(event)

        assert any("has no effect" in record.message for record in caplog.records)


class TestSyncAndAsyncOverrides:
    """Lifecycle overrides may be sync or async; the registry awaits based on
    the returned value (inspect.isawaitable), not on iscoroutinefunction."""

    @pytest.mark.asyncio
    async def test_sync_def_override_is_dispatched(self, hook_registry, agent):
        """A plain sync `def` override returns its action directly."""

        class SyncDeny(InterventionHandler):
            name = "sync-deny"

            def before_tool_call(self, event):
                return Deny(reason="sync denial")

        InterventionRegistry([SyncDeny()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool == "DENIED: sync denial"

    @pytest.mark.asyncio
    async def test_async_def_override_is_awaited(self, hook_registry, agent):
        """An `async def` override returns a coroutine that the registry awaits."""

        class AsyncDeny(InterventionHandler):
            name = "async-deny-override"

            async def before_tool_call(self, event):
                return Deny(reason="async denial")

        InterventionRegistry([AsyncDeny()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool == "DENIED: async denial"

    @pytest.mark.asyncio
    async def test_sync_def_returning_coroutine_is_awaited(self, hook_registry, agent):
        """A sync `def` that hands back a coroutine is still awaited.

        This is the case iscoroutinefunction(method_fn) misses (the *method* is
        sync) but isawaitable(result) catches (the *value* is awaitable). Guards
        against the un-awaited-coroutine regression the _MaybeAwaitable annotation
        would otherwise invite.
        """

        async def _decide():
            return Deny(reason="deferred denial")

        class SyncReturnsCoroutine(InterventionHandler):
            name = "sync-returns-coroutine"

            def before_tool_call(self, event):
                return _decide()

        InterventionRegistry([SyncReturnsCoroutine()], hook_registry)

        event = make_before_tool_call_event(agent)
        await hook_registry.invoke_callbacks_async(event)
        assert event.cancel_tool == "DENIED: deferred denial"
