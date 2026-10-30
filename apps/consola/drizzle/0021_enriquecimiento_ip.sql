CREATE TABLE "enriquecimiento_ip" (
	"ip" text PRIMARY KEY NOT NULL,
	"pais" text,
	"operador" text,
	"puntuacion" integer,
	"clasificacion" text,
	"total_informes" integer,
	"tor" boolean DEFAULT false NOT NULL,
	"fuentes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"crudo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cuando" timestamp with time zone DEFAULT now() NOT NULL
);
