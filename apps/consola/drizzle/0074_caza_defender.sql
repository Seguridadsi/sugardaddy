CREATE TABLE "caza_defender" (
	"ip" text PRIMARY KEY NOT NULL,
	"cuando" timestamp with time zone DEFAULT now() NOT NULL,
	"horas" integer NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"tablas" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"primero" timestamp with time zone,
	"ultimo" timestamp with time zone
);
