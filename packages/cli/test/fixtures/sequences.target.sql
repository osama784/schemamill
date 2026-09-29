--
-- PostgreSQL database dump (sequences target)
--

CREATE SEQUENCE public.added_seq
    AS bigint
    START WITH 3
    INCREMENT BY 2
    MINVALUE 1
    MAXVALUE 100
    CACHE 4
    CYCLE;

CREATE SEQUENCE public.kept_seq
    AS bigint
    START WITH 10
    INCREMENT BY 5
    NO MINVALUE
    NO MAXVALUE
    CACHE 8
    CYCLE;

CREATE TABLE public.new_table (
    id bigint NOT NULL
);

CREATE SEQUENCE public.new_table_id_seq
    AS bigint
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.new_table_id_seq OWNED BY public.new_table.id;

CREATE TABLE public.target_owner (
    id bigint NOT NULL
);

CREATE SEQUENCE public.moved_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.moved_seq OWNED BY public.target_owner.id;
