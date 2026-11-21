// Only allow tools outside production
permit(
  principal,
  action,
  resource
) when {
  context.session.environment != "production"
};
