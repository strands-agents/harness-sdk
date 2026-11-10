// Simple policy: allow search for any principal
permit(
  principal,
  action == Action::"search",
  resource
);
