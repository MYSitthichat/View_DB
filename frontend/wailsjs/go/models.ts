export namespace connection {
	
	export class ConnectionProfile {
	    id: string;
	    name: string;
	    version: string;
	    url: string;
	    username?: string;
	    hasPassword: boolean;
	    hasToken: boolean;
	    organization?: string;
	    bucket?: string;
	    database?: string;
	    retentionPolicy?: string;
	    tlsInsecure: boolean;
	    timeoutSeconds: number;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionProfile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.version = source["version"];
	        this.url = source["url"];
	        this.username = source["username"];
	        this.hasPassword = source["hasPassword"];
	        this.hasToken = source["hasToken"];
	        this.organization = source["organization"];
	        this.bucket = source["bucket"];
	        this.database = source["database"];
	        this.retentionPolicy = source["retentionPolicy"];
	        this.tlsInsecure = source["tlsInsecure"];
	        this.timeoutSeconds = source["timeoutSeconds"];
	    }
	}
	export class ConnectionUpsert {
	    id: string;
	    name: string;
	    version: string;
	    url: string;
	    username?: string;
	    password?: string;
	    token?: string;
	    organization?: string;
	    bucket?: string;
	    database?: string;
	    retentionPolicy?: string;
	    tlsInsecure: boolean;
	    timeoutSeconds: number;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionUpsert(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.version = source["version"];
	        this.url = source["url"];
	        this.username = source["username"];
	        this.password = source["password"];
	        this.token = source["token"];
	        this.organization = source["organization"];
	        this.bucket = source["bucket"];
	        this.database = source["database"];
	        this.retentionPolicy = source["retentionPolicy"];
	        this.tlsInsecure = source["tlsInsecure"];
	        this.timeoutSeconds = source["timeoutSeconds"];
	    }
	}

}

export namespace influx {
	
	export class DatabaseInfo {
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new DatabaseInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	    }
	}
	export class FieldInfo {
	    name: string;
	    type: string;
	
	    static createFrom(source: any = {}) {
	        return new FieldInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	    }
	}
	export class MeasurementInfo {
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new MeasurementInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	    }
	}
	export class QueryScope {
	    database: string;
	    bucket: string;
	    org: string;
	
	    static createFrom(source: any = {}) {
	        return new QueryScope(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.database = source["database"];
	        this.bucket = source["bucket"];
	        this.org = source["org"];
	    }
	}
	export class TagInfo {
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new TagInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	    }
	}

}

export namespace query {
	
	export class QueryHistoryItem {
	    id: string;
	    // Go type: time
	    timestamp: any;
	    connectionId: string;
	    database?: string;
	    statement: string;
	    status: string;
	
	    static createFrom(source: any = {}) {
	        return new QueryHistoryItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.timestamp = this.convertValues(source["timestamp"], null);
	        this.connectionId = source["connectionId"];
	        this.database = source["database"];
	        this.statement = source["statement"];
	        this.status = source["status"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class QueryResult {
	    columns: string[];
	    rows: any[][];
	    count: number;
	
	    static createFrom(source: any = {}) {
	        return new QueryResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.columns = source["columns"];
	        this.rows = source["rows"];
	        this.count = source["count"];
	    }
	}
	export class QueryRequest {
	    connectionId: string;
	    statement: string;
	    database: string;
	    bucket: string;
	    organization: string;
	    limit: number;
	    timeout: number;
	    selectedColumns?: string[];
	
	    static createFrom(source: any = {}) {
	        return new QueryRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connectionId = source["connectionId"];
	        this.statement = source["statement"];
	        this.database = source["database"];
	        this.bucket = source["bucket"];
	        this.organization = source["organization"];
	        this.limit = source["limit"];
	        this.timeout = source["timeout"];
	        this.selectedColumns = source["selectedColumns"];
	    }
	}
	export class QueryJob {
	    id: string;
	    status: string;
	    request: QueryRequest;
	    result?: QueryResult;
	    error?: string;
	    // Go type: time
	    createdAt: any;
	    // Go type: time
	    startedAt?: any;
	    // Go type: time
	    finishedAt?: any;
	
	    static createFrom(source: any = {}) {
	        return new QueryJob(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.status = source["status"];
	        this.request = this.convertValues(source["request"], QueryRequest);
	        this.result = this.convertValues(source["result"], QueryResult);
	        this.error = source["error"];
	        this.createdAt = this.convertValues(source["createdAt"], null);
	        this.startedAt = this.convertValues(source["startedAt"], null);
	        this.finishedAt = this.convertValues(source["finishedAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class SavedQuery {
	    id: string;
	    name: string;
	    connectionId: string;
	    database?: string;
	    statement: string;
	
	    static createFrom(source: any = {}) {
	        return new SavedQuery(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.connectionId = source["connectionId"];
	        this.database = source["database"];
	        this.statement = source["statement"];
	    }
	}

}

