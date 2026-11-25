--
-- PostgreSQL database dump (not-null comment target)
--

CREATE TABLE public.t (
    c text NOT NULL,
    d text NOT NULL
);

COMMENT ON CONSTRAINT t_c_not_null ON public.t IS 'a generated not-null name with a comment';
