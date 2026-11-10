// Allow sending emails, but cap at 3 per session
permit(
  principal,
  action == Action::"send_email",
  resource
) when {
  context.session.call_count < 3
};
