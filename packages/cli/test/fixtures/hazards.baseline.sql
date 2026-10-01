--
-- PostgreSQL database dump (hazards baseline)
--

CREATE SEQUENCE public.kept_seq
    AS bigint
    START WITH 1
    INCREMENT BY 1
    MINVALUE 1
    MAXVALUE 1000
    CACHE 1
    NO CYCLE;
