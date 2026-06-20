package query

import "time"

type JobStatus string

const (
	JobQueued    JobStatus = "queued"
	JobRunning   JobStatus = "running"
	JobSuccess   JobStatus = "success"
	JobError     JobStatus = "error"
	JobCancelled JobStatus = "cancelled"
)

type QueryJob struct {
	ID         string       `json:"id"`
	Status     JobStatus    `json:"status"`
	Request    QueryRequest `json:"request"`
	Result     *QueryResult `json:"result,omitempty"`
	Error      string       `json:"error,omitempty"`
	CreatedAt  time.Time    `json:"createdAt"`
	StartedAt  *time.Time   `json:"startedAt,omitempty"`
	FinishedAt *time.Time   `json:"finishedAt,omitempty"`
}
