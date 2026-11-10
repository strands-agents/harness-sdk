// Allow search, explicitly deny delete
permit(
  principal,
  action == Action::"search",
  resource
);

forbid(
  principal,
  action == Action::"delete_record",
  resource
);
