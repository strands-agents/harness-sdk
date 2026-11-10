permit(principal, action, resource)
when { context.session.environment != "production" };
