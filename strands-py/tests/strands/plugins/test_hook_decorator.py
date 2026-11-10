"""Tests for the @hook decorator."""

import unittest.mock

import pytest

from strands.hooks import (
    AfterInvocationEvent,
    AfterModelCallEvent,
    BeforeInvocationEvent,
    BeforeModelCallEvent,
)
from strands.plugins.decorator import hook


class TestHookDecoratorBasic:
    """Tests for basic @hook decorator functionality."""

    def test_hook_decorator_marks_method(self):
        """Test that @hook marks a method with hook metadata."""

        @hook
        def on_before_model_call(event: BeforeModelCallEvent):
            pass

        assert hasattr(on_before_model_call, "_hook_event_types")
        assert BeforeModelCallEvent in on_before_model_call._hook_event_types

    def test_hook_decorator_with_parentheses(self):
        """Test that @hook() syntax also works."""

        @hook()
        def on_before_model_call(event: BeforeModelCallEvent):
            pass

        assert hasattr(on_before_model_call, "_hook_event_types")
        assert BeforeModelCallEvent in on_before_model_call._hook_event_types

    def test_hook_decorator_preserves_function_metadata(self):
        """Test that @hook preserves the original function's metadata."""

        @hook
        def on_before_model_call(event: BeforeModelCallEvent):
            """Docstring for the hook."""
            pass

        assert on_before_model_call.__name__ == "on_before_model_call"
        assert on_before_model_call.__doc__ == "Docstring for the hook."

    def test_hook_decorator_function_still_callable(self):
        """Test that decorated function can still be called normally."""
        call_count = 0

        @hook
        def on_before_model_call(event: BeforeModelCallEvent):
            nonlocal call_count
            call_count += 1

        mock_event = unittest.mock.MagicMock(spec=BeforeModelCallEvent)
        on_before_model_call(mock_event)
        assert call_count == 1


class TestHookDecoratorEventTypeInference:
    """Tests for event type inference from type hints."""

    def test_hook_infers_event_type_from_type_hint(self):
        """Test that @hook infers event type from the first parameter's type hint."""

        @hook
        def handler(event: BeforeInvocationEvent):
            pass

        assert BeforeInvocationEvent in handler._hook_event_types

    def test_hook_infers_different_event_types(self):
        """Test that different event types are correctly inferred."""

        @hook
        def handler1(event: BeforeModelCallEvent):
            pass

        @hook
        def handler2(event: AfterModelCallEvent):
            pass

        @hook
        def handler3(event: AfterInvocationEvent):
            pass

        assert BeforeModelCallEvent in handler1._hook_event_types
        assert AfterModelCallEvent in handler2._hook_event_types
        assert AfterInvocationEvent in handler3._hook_event_types

    def test_hook_skips_cls_parameter(self):
        """Test that @hook skips 'cls' parameter for classmethods."""

        class MyClass:
            @classmethod
            @hook
            def handler(cls, event: BeforeModelCallEvent):
                pass

        assert BeforeModelCallEvent in MyClass.handler._hook_event_types


class TestHookDecoratorUnionTypes:
    """Tests for union type support in @hook decorator."""

    def test_hook_supports_union_types_with_pipe(self):
        """Test that @hook supports union types using | syntax."""

        @hook
        def handler(event: BeforeModelCallEvent | AfterModelCallEvent):
            pass

        assert BeforeModelCallEvent in handler._hook_event_types
        assert AfterModelCallEvent in handler._hook_event_types

    def test_hook_supports_union_types_with_typing_union(self):
        """Test that @hook supports Union[] syntax."""

        @hook
        def handler(event: BeforeModelCallEvent | AfterModelCallEvent):
            pass

        assert BeforeModelCallEvent in handler._hook_event_types
        assert AfterModelCallEvent in handler._hook_event_types

    def test_hook_supports_multiple_union_types(self):
        """Test that @hook supports unions with more than two types."""

        @hook
        def handler(event: BeforeModelCallEvent | AfterModelCallEvent | BeforeInvocationEvent):
            pass

        assert BeforeModelCallEvent in handler._hook_event_types
        assert AfterModelCallEvent in handler._hook_event_types
        assert BeforeInvocationEvent in handler._hook_event_types


class TestHookDecoratorErrorHandling:
    """Tests for error handling in @hook decorator."""

    def test_hook_raises_error_without_type_hint(self):
        """Test that @hook raises error when no type hint is provided."""
        with pytest.raises(ValueError, match="cannot infer event type"):

            @hook
            def handler(event):
                pass

    def test_hook_raises_error_with_non_hook_event_type(self):
        """Test that @hook raises error when type hint is not a HookEvent subclass."""
        with pytest.raises(ValueError, match="must be a subclass of BaseHookEvent"):

            @hook
            def handler(event: str):
                pass

    def test_hook_raises_error_with_none_in_union(self):
        """Test that @hook raises error when union contains None."""
        with pytest.raises(ValueError, match="None is not a valid event type"):

            @hook
            def handler(event: BeforeModelCallEvent | None):
                pass


class TestHookDecoratorWithMethods:
    """Tests for @hook decorator on class methods."""

    def test_hook_works_on_instance_method(self):
        """Test that @hook works correctly on instance methods."""

        class MyClass:
            @hook
            def handler(self, event: BeforeModelCallEvent):
                pass

        instance = MyClass()
        assert hasattr(instance.handler, "_hook_event_types")
        assert BeforeModelCallEvent in instance.handler._hook_event_types

    def test_hook_instance_method_is_callable(self):
        """Test that decorated instance method can be called."""
        call_count = 0

        class MyClass:
            @hook
            def handler(self, event: BeforeModelCallEvent):
                nonlocal call_count
                call_count += 1

        instance = MyClass()
        mock_event = unittest.mock.MagicMock(spec=BeforeModelCallEvent)
        instance.handler(mock_event)
        assert call_count == 1

    def test_hook_method_accesses_self(self):
        """Test that decorated method can access self."""

        class MyClass:
            def __init__(self):
                self.events_received = []

            @hook
            def handler(self, event: BeforeModelCallEvent):
                self.events_received.append(event)

        instance = MyClass()
        mock_event = unittest.mock.MagicMock(spec=BeforeModelCallEvent)
        instance.handler(mock_event)
        assert len(instance.events_received) == 1
        assert instance.events_received[0] is mock_event


class TestHookDecoratorAsync:
    """Tests for async functions with @hook decorator."""

    def test_hook_works_on_async_function(self):
        """Test that @hook works on async functions."""

        @hook
        async def handler(event: BeforeModelCallEvent):
            pass

        assert hasattr(handler, "_hook_event_types")
        assert BeforeModelCallEvent in handler._hook_event_types

    @pytest.mark.asyncio
    async def test_hook_async_function_is_callable(self):
        """Test that decorated async function can be awaited."""
        call_count = 0

        @hook
        async def handler(event: BeforeModelCallEvent):
            nonlocal call_count
            call_count += 1

        mock_event = unittest.mock.MagicMock(spec=BeforeModelCallEvent)
        await handler(mock_event)
        assert call_count == 1
