package query

import (
	"context"
	"fmt"
	"runtime"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

type Runner func(ctx context.Context, req QueryRequest) (QueryResult, error)

type ManagerOptions struct {
	MaxConcurrent int
	MaxJobs       int
}

type Manager struct {
	mu      sync.RWMutex
	jobs    map[string]*jobInternal
	sem     chan struct{}
	maxJobs int
}

type jobInternal struct {
	job    QueryJob
	cancel context.CancelFunc
}

func NewManager(opts ManagerOptions) *Manager {
	maxConcurrent := opts.MaxConcurrent
	if maxConcurrent <= 0 {
		maxConcurrent = runtime.NumCPU()
		if maxConcurrent < 2 {
			maxConcurrent = 2
		}
	}
	maxJobs := opts.MaxJobs
	if maxJobs <= 0 {
		maxJobs = 100
	}
	return &Manager{
		jobs:    map[string]*jobInternal{},
		sem:     make(chan struct{}, maxConcurrent),
		maxJobs: maxJobs,
	}
}

func (m *Manager) Start(req QueryRequest, runner Runner) (string, error) {
	if runner == nil {
		return "", fmt.Errorf("runner is required")
	}
	if req.ConnectionID == "" {
		return "", fmt.Errorf("connection id is required")
	}

	id := uuid.NewString()
	created := time.Now()
	ctx, cancel := context.WithCancel(context.Background())

	internal := &jobInternal{job: QueryJob{ID: id, Status: JobQueued, Request: req, CreatedAt: created}, cancel: cancel}

	m.mu.Lock()
	m.jobs[id] = internal
	m.pruneLocked()
	m.mu.Unlock()

	go m.runJob(ctx, internal, runner)
	return id, nil
}

func (m *Manager) runJob(ctx context.Context, internal *jobInternal, runner Runner) {
	// Acquire a worker slot
	m.sem <- struct{}{}
	defer func() { <-m.sem }()

	started := time.Now()
	m.mu.Lock()
	internal.job.Status = JobRunning
	internal.job.StartedAt = &started
	m.mu.Unlock()

	result, err := runner(ctx, internal.job.Request)
	finished := time.Now()

	m.mu.Lock()
	defer m.mu.Unlock()
	internal.job.FinishedAt = &finished
	if err != nil {
		if ctx.Err() != nil {
			internal.job.Status = JobCancelled
			internal.job.Error = "cancelled"
			return
		}
		internal.job.Status = JobError
		internal.job.Error = err.Error()
		return
	}
	internal.job.Status = JobSuccess
	internal.job.Result = &result
}

func (m *Manager) Get(id string) (QueryJob, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	internal, ok := m.jobs[id]
	if !ok {
		return QueryJob{}, false
	}
	return internal.job, true
}

func (m *Manager) Cancel(id string) bool {
	m.mu.RLock()
	internal, ok := m.jobs[id]
	m.mu.RUnlock()
	if !ok {
		return false
	}
	internal.cancel()
	return true
}

func (m *Manager) pruneLocked() {
	if len(m.jobs) <= m.maxJobs {
		return
	}
	ids := make([]string, 0, len(m.jobs))
	for id := range m.jobs {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		ai := m.jobs[ids[i]].job
		aj := m.jobs[ids[j]].job
		ati := ai.CreatedAt
		atj := aj.CreatedAt
		if ai.FinishedAt != nil {
			ati = *ai.FinishedAt
		}
		if aj.FinishedAt != nil {
			atj = *aj.FinishedAt
		}
		return ati.Before(atj)
	})

	removeable := func(s JobStatus) bool {
		return s == JobSuccess || s == JobError || s == JobCancelled
	}

	for len(m.jobs) > m.maxJobs {
		removed := false
		for _, id := range ids {
			if internal, ok := m.jobs[id]; ok && removeable(internal.job.Status) {
				delete(m.jobs, id)
				removed = true
				break
			}
		}
		if removed {
			continue
		}
		delete(m.jobs, ids[0])
		ids = ids[1:]
	}
}
