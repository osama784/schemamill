DROP INDEX CONCURRENTLY users_age_idx;

CREATE INDEX CONCURRENTLY users_age_idx_v2 ON public.users USING btree (age);
