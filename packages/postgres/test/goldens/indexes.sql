BEGIN;
DROP INDEX public.users_age_idx;
DROP INDEX public.users_email_idx;
CREATE INDEX ON public.users USING btree (created_at);
CREATE INDEX users_name_idx ON public.users USING btree (name);
CREATE UNIQUE INDEX users_email_idx ON public.users USING btree (email);
COMMIT;
