CREATE TABLE public.t (a integer);
ALTER TABLE ONLY public.t ADD CONSTRAINT t_excl EXCLUDE USING gist (a WITH <>);
COMMENT ON CONSTRAINT t_excl ON public.t IS 'old note';
