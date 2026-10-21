CREATE TABLE "instaladores_sensor" (
	"codigo_hash" text PRIMARY KEY NOT NULL,
	"sensor" text NOT NULL,
	"caduca" timestamp with time zone NOT NULL,
	"usado" timestamp with time zone,
	"creado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sensores" ADD COLUMN "remoto" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sensores" ADD COLUMN "version" text;--> statement-breakpoint
ALTER TABLE "instaladores_sensor" ADD CONSTRAINT "instaladores_sensor_sensor_sensores_id_fk" FOREIGN KEY ("sensor") REFERENCES "public"."sensores"("id") ON DELETE no action ON UPDATE no action;