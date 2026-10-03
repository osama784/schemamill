BEGIN;
DROP INDEX public.child_old_idx;
COMMIT;

CREATE INDEX CONCURRENTLY child_new_idx ON public.child USING btree (parent_id);

BEGIN;
ALTER TABLE public.child ADD CONSTRAINT child_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parent(id);
COMMIT;
