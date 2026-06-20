package query

func ApplyDefaultLimit(req QueryRequest) QueryRequest {
	if req.Limit <= 0 {
		req.Limit = 1000
	}
	return req
}
