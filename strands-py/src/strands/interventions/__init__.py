"""First-class intervention primitive for agent control.

The intervention system provides a composable way to add authorization, steering,
guardrails, and other control layers to agents. Each control layer is an
InterventionHandler that intercepts lifecycle events and returns typed decisions.

Example:
    ```python
    from strands import Agent, InterventionHandler
    from strands.interventions import Deny, Proceed

    class MyAuth(InterventionHandler):
        name = "my-auth"

        def before_tool_call(self, event):
            if not self.is_authorized(event):
                return Deny(reason="not authorized")
            return Proceed()

    agent = Agent(interventions=[MyAuth()])
    ```
"""

from .actions import Confirm as Confirm
from .actions import Deny as Deny
from .actions import Guide as Guide
from .actions import InterventionAction as InterventionAction
from .actions import Proceed as Proceed
from .actions import Transform as Transform
from .handler import InterventionHandler as InterventionHandler
from .handler import OnError as OnError
