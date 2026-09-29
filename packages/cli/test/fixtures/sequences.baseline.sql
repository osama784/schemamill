--
-- PostgreSQL database dump (sequences baseline)
--

CREATE SEQUENCE public.dropped_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE public.kept_seq
    AS integer
    START WITH 5
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.old_owner (
    id bigint NOT NULL
);

CREATE SEQUENCE public.moved_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.moved_seq OWNED BY public.old_owner.id;

CREATE TABLE public.gone_owner (
    id bigint NOT NULL
);

CREATE SEQUENCE public.cascaded_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.cascaded_seq OWNED BY public.gone_owner.id;

CREATE TABLE public.target_owner (
    id bigint NOT NULL
);
