DROP SCHEMA IF EXISTS sim CASCADE;
CREATE SCHEMA sim;
CREATE TABLE sim.sheet_rows (row_no bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event_id uuid NOT NULL, row_text text NOT NULL);
GRANT USAGE ON SCHEMA sim TO opsbridge_app;
GRANT SELECT, INSERT ON sim.sheet_rows TO opsbridge_app;
