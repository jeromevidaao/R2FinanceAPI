/**
 * R2FinanceApiHandler — device-facing API (Phase 3).
 * Phase 1 stub: health + naming only. No DDB yet.
 */

const RESOURCE = {
  apiName: 'R2FinanceAPI',
  lambda: 'R2FinanceApiHandler',
  table: 'R2Finance',
};

exports.handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || 'GET';
  const path = event?.rawPath || event?.path || '/';

  if (method === 'GET' && (path === '/' || path === '/health')) {
    return json(200, {
      ok: true,
      service: 'R2FinanceAPI',
      phase: 1,
      resources: RESOURCE,
      message: 'Stub only — deploy DynamoDB + routes in Phase 3',
    });
  }

  return json(501, {
    error: 'not_implemented',
    detail: 'R2FinanceAPI Phase 1 scaffold — implement sync routes in Phase 3',
    path,
    method,
  });
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    },
    body: JSON.stringify(body),
  };
}

// Local smoke
if (require.main === module) {
  exports.handler({ rawPath: '/health', requestContext: { http: { method: 'GET' } } }).then((r) => {
    console.log(r.statusCode, r.body);
  });
}
