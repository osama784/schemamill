CREATE TABLE public.t (a integer);
ALTER TABLE ONLY public.t ADD CONSTRAINT t_excl EXCLUDE USING gist (a WITH =) WHERE (a > 0);
COMMENT ON CONSTRAINT t_excl ON public.t IS 'new note';
