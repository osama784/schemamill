--
-- PostgreSQL database dump (identity baseline)
--

CREATE TABLE app.recreate (
    id integer NOT NULL
);

ALTER TABLE app.recreate ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.recreate_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.gain (
    id integer NOT NULL
);

CREATE TABLE public.lose (
    id integer NOT NULL
);

ALTER TABLE public.lose ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.lose_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.to_identity (
    id integer NOT NULL
);

CREATE SEQUENCE public.to_identity_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.to_identity_id_seq OWNED BY public.to_identity.id;

ALTER TABLE ONLY public.to_identity ALTER COLUMN id SET DEFAULT nextval('public.to_identity_id_seq'::regclass);

CREATE TABLE public.to_serial (
    id integer NOT NULL
);

ALTER TABLE public.to_serial ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.to_serial_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.tune (
    id integer NOT NULL
);

ALTER TABLE public.tune ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.tune_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
