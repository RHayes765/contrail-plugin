/** Typed errors surfaced to the agent as tool errors with stable codes. */

export class ContrailError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConnectionNotFoundError extends ContrailError {
  constructor(ref: string) {
    super(
      `No connection matches "${ref}". Call list_connections to see what is connected, or connect_org to add one.`,
      'connection_not_found',
    );
  }
}

export class GrantDeniedError extends ContrailError {
  constructor(alias: string, grant: string, tool: string) {
    super(
      `Connection "${alias}" does not hold the "${grant}" grant required by ${tool}. ` +
        `Grants are set by a human on the connection management page — call manage_connection ` +
        `to open it. Do not retry without the grant.`,
      'grant_denied',
    );
  }
}

export class FlowInProgressError extends ContrailError {
  constructor(message: string) {
    super(message, 'flow_in_progress');
  }
}

export class OAuthFlowError extends ContrailError {
  constructor(message: string) {
    super(message, 'oauth_flow_failed');
  }
}
