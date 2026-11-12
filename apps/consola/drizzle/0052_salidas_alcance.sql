CREATE TABLE "salidas_alcance" (
	"salida" uuid NOT NULL,
	"nivel" text NOT NULL,
	"objeto" text NOT NULL,
	"envia" boolean NOT NULL,
	"quien" text,
	"cambiado" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salidas_alcance_salida_nivel_objeto_pk" PRIMARY KEY("salida","nivel","objeto")
);
--> statement-breakpoint
ALTER TABLE "salidas_alcance" ADD CONSTRAINT "salidas_alcance_salida_salidas_id_fk" FOREIGN KEY ("salida") REFERENCES "public"."salidas"("id") ON DELETE cascade ON UPDATE no action;