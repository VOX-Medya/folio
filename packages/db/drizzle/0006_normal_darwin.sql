CREATE TABLE "job_completion_receipts" (
	"queue_name" varchar(80) NOT NULL,
	"operation_key" varchar(200) NOT NULL,
	"payload_sha256" varchar(64) NOT NULL,
	"first_job_id" uuid NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_completion_receipts_queue_name_operation_key_pk" PRIMARY KEY("queue_name","operation_key")
);
