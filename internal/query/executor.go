package query

import "context"

type Executor struct{}

func (e Executor) Execute(ctx context.Context, req QueryRequest) (QueryResult, error) {
	_ = ctx
	req = ApplyDefaultLimit(req)
	return QueryResult{}, nil
}
