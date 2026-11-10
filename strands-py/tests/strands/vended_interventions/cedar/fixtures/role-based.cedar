permit(principal, action, resource)
when { context.session.role == "admin" };

permit(principal, action == Action::"search", resource)
when { context.session.role == "analyst" };
