CREATE TABLE public.accounts (
    id bigint NOT NULL,
    balance numeric(12,2) NOT NULL DEFAULT 0,
    CONSTRAINT accounts_pkey PRIMARY KEY (id)
);
CREATE TABLE public.orders (
    id bigint NOT NULL,
    "user" bigint,
    total numeric(12,2) DEFAULT 0,
    CONSTRAINT orders_pkey PRIMARY KEY (id)
);
CREATE TABLE public.users (
    id bigint NOT NULL,
    "Mixed Case" text NOT NULL DEFAULT 'x',
    CONSTRAINT users_pkey PRIMARY KEY (id)
);
ALTER TABLE public.orders ADD CONSTRAINT orders_user_fkey FOREIGN KEY ("user") REFERENCES public.users(id) ON DELETE CASCADE;
