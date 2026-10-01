--
-- PostgreSQL database dump (hazards target)
--

CREATE SEQUENCE public.bad_cache
    AS bigint
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 0;

CREATE SEQUENCE public.bad_increment
    AS bigint
    INCREMENT BY 0
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE public.bad_range
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 9999999999
    CACHE 1;

CREATE SEQUENCE public.bad_two
    INCREMENT BY 1
    MINVALUE 200
    MAXVALUE 100
    CACHE 1;

CREATE SEQUENCE public.kept_seq
    AS bigint
    START WITH 1
    INCREMENT BY 1
    MINVALUE 1
    MAXVALUE 100
    CACHE 1
    NO CYCLE;

CREATE TABLE app.bad_identity (
    id integer GENERATED ALWAYS AS IDENTITY (
        CACHE 0
    )
);
