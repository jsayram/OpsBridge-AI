-- P3.5: a sync can add snapshot rows, which are read-only source facts. No UPDATE: a recorded
-- quantity can't change, and inventory_items stays read-only for the runtime role.
GRANT INSERT ON app.inventory_snapshots TO opsbridge_app;
