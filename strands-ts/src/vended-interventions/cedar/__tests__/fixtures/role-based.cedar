// Admins can use any tool
permit(
  principal is User,
  action,
  resource
) when {
  principal.role == "admin"
};

// Analysts can only search and query
permit(
  principal is User,
  action == Action::"search",
  resource
) when {
  principal.role == "analyst"
};

permit(
  principal is User,
  action == Action::"query_database",
  resource
) when {
  principal.role == "analyst"
};
