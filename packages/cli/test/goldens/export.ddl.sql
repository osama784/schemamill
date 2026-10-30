BEGIN;
CREATE SCHEMA IF NOT EXISTS "Weird Schema";
CREATE SCHEMA IF NOT EXISTS app;
CREATE SEQUENCE app.order_number_seq AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1000 CACHE 1 NO CYCLE;
CREATE TABLE "Weird Schema".items (
    id integer NOT NULL,
    label text NOT NULL,
    CONSTRAINT items_pkey PRIMARY KEY (id)
);
CREATE TABLE app.orders (
    id bigint NOT NULL,
    user_id integer NOT NULL,
    placed_on date DEFAULT CURRENT_DATE,
    PRIMARY KEY (id)
);
CREATE TABLE app.users (
    id integer NOT NULL,
    email text NOT NULL,
    display_name text,
    CONSTRAINT users_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX users_email_idx ON app.users USING btree (email);
ALTER TABLE app.orders ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE;
CREATE VIEW "Weird Schema".item_labels AS SELECT id, label FROM "Weird Schema".items WITH LOCAL CHECK OPTION;
COMMENT ON VIEW "Weird Schema".item_labels IS 'labels only';
COMMENT ON TABLE app.users IS 'one row per account';
COMMIT;
