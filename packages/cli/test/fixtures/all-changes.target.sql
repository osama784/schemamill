--
-- PostgreSQL database dump (target)
--

CREATE TABLE public.added (
    id integer NOT NULL,
    name text NOT NULL
);

CREATE TABLE public.fk_added (
    id integer NOT NULL,
    target_id integer
);

CREATE TABLE public.fk_changed (
    id integer NOT NULL,
    target_id integer
);

CREATE TABLE public.fk_columns_changed (
    id integer NOT NULL,
    target_id integer
);

CREATE TABLE public.fk_columns_target (
    a integer NOT NULL,
    b integer NOT NULL
);

CREATE TABLE public.fk_name_changed (
    id integer NOT NULL,
    target_id integer
);

CREATE TABLE public.fk_on_update_changed (
    id integer NOT NULL,
    target_id integer
);

CREATE TABLE public.fk_removed (
    id integer NOT NULL,
    target_id integer
);

CREATE TABLE public.kept (
    id integer NOT NULL,
    added text,
    metric bigint NOT NULL DEFAULT 0,
    note text
);

CREATE TABLE public.pk_added (
    id integer NOT NULL,
    label text
);

CREATE TABLE public.pk_changed (
    a integer NOT NULL,
    b integer NOT NULL
);

CREATE TABLE public.pk_removed (
    id integer NOT NULL
);

ALTER TABLE ONLY public.added ADD CONSTRAINT added_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fk_added ADD CONSTRAINT fk_added_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fk_added
    ADD CONSTRAINT fk_added_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.pk_added(id);

ALTER TABLE ONLY public.fk_changed ADD CONSTRAINT fk_changed_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fk_changed
    ADD CONSTRAINT fk_changed_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.fk_added(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.fk_columns_changed ADD CONSTRAINT fk_columns_changed_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fk_columns_changed
    ADD CONSTRAINT fk_columns_changed_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.fk_columns_target(b);

ALTER TABLE ONLY public.fk_columns_target ADD CONSTRAINT fk_columns_target_pkey PRIMARY KEY (b);

ALTER TABLE ONLY public.fk_name_changed ADD CONSTRAINT fk_name_changed_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fk_name_changed
    ADD CONSTRAINT fk_name_changed_target_id_fkey_v2 FOREIGN KEY (target_id) REFERENCES public.fk_added(id);

ALTER TABLE ONLY public.fk_on_update_changed ADD CONSTRAINT fk_on_update_changed_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fk_on_update_changed
    ADD CONSTRAINT fk_on_update_changed_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.fk_added(id) ON UPDATE RESTRICT;

ALTER TABLE ONLY public.fk_removed ADD CONSTRAINT fk_removed_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.kept ADD CONSTRAINT kept_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pk_added ADD CONSTRAINT pk_added_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pk_changed ADD CONSTRAINT pk_changed_pkey_v2 PRIMARY KEY (b, a);
