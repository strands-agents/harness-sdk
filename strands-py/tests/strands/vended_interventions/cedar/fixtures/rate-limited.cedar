permit(principal, action == Action::"send_email", resource)
when { context.session.call_count < 3 };

permit(principal, action == Action::"search", resource);
