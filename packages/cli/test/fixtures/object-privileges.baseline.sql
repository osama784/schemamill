CREATE TABLE app.t (
    id integer NOT NULL,
    email text
);

CREATE SEQUENCE app.s
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER TABLE app.t OWNER TO postgres;

ALTER SEQUENCE app.s OWNER TO postgres;

GRANT ALL ON TABLE app.t TO app_user;

GRANT USAGE ON SEQUENCE app.s TO app_user;
