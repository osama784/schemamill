BEGIN;
CREATE UNLOGGED TABLE public.created (
    id integer NOT NULL,
    fresh text COLLATE pg_catalog."C"
);
ALTER TABLE ONLY public.created ALTER COLUMN fresh SET STORAGE EXTERNAL;
ALTER TABLE ONLY public.created ALTER COLUMN fresh SET COMPRESSION pglz;
ALTER TABLE public.attrs ADD COLUMN added text COLLATE pg_catalog."C";
ALTER TABLE ONLY public.attrs ALTER COLUMN added SET STORAGE EXTENDED;
ALTER TABLE ONLY public.attrs ALTER COLUMN added SET COMPRESSION pglz;
ALTER TABLE public.attrs ALTER COLUMN label TYPE text COLLATE pg_catalog."POSIX";
ALTER TABLE public.attrs ALTER COLUMN code TYPE text;
ALTER TABLE public.attrs ALTER COLUMN bare TYPE text COLLATE pg_catalog."C";
ALTER TABLE ONLY public.attrs ALTER COLUMN s_add SET STORAGE EXTERNAL;
ALTER TABLE ONLY public.attrs ALTER COLUMN s_reset SET STORAGE DEFAULT;
ALTER TABLE ONLY public.attrs ALTER COLUMN comp_add SET COMPRESSION lz4;
ALTER TABLE ONLY public.attrs ALTER COLUMN comp_reset SET COMPRESSION default;
ALTER TABLE public.attrs ALTER COLUMN merged TYPE character varying(12) COLLATE pg_catalog."POSIX";
ALTER TABLE ONLY public.attrs ALTER COLUMN merged SET STORAGE EXTERNAL;
ALTER TABLE public.backed SET LOGGED;
ALTER TABLE public.flipped SET UNLOGGED;
COMMIT;
