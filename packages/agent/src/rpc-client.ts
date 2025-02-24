import { utils as cryptoUtils } from '@web5/crypto';
import { RecordsReadReply, UnionMessageReply } from '@tbd54566975/dwn-sdk-js';

import type { JsonRpcResponse } from './json-rpc.js';

import { createJsonRpcRequest, parseJson } from './json-rpc.js';

/**
 * Interface that can be implemented to communicate with {@link Web5Agent | Web5 Agent}
 * implementations via JSON-RPC.
 */
export interface DidRpc {
  get transportProtocols(): string[]
  sendDidRequest(request: DidRpcRequest): Promise<DidRpcResponse>
}

export enum DidRpcMethod {
  Create = 'did.create',
  Resolve = 'did.resolve'
}

export type DidRpcRequest = {
  data: string;
  method: DidRpcMethod;
  url: string;
}

export type DidRpcResponse = {
  data?: string;
  ok: boolean;
  status: RpcStatus;
}

/**
 * Interface for communicating with {@link https://github.com/TBD54566975/dwn-server | DWN Servers}
 * via JSON-RPC, supporting operations like sending DWN requests.
 */
export interface DwnRpc {
  /**
   * Lists the transport protocols supported by the DWN RPC client, such as HTTP or HTTPS.
   * @returns An array of strings representing the supported transport protocols.
   */
  get transportProtocols(): string[]

  /**
   * Sends a request to a DWN Server using the specified DWN RPC request parameters.
   *
   * @param request - The DWN RPC request containing the URL, target DID, message, and optional data.
   * @returns A promise that resolves to the response from the DWN server.
   */
  sendDwnRequest(request: DwnRpcRequest): Promise<DwnRpcResponse>
}


/**
 * Represents a JSON RPC request to a DWN server, including the URL, target DID, the message to be
 * processed, and optional data.
 */
export type DwnRpcRequest = {
  /** Optional data to be sent with the request. */
  data?: any;

  /** The URL of the DWN server to which the request is sent. */
  dwnUrl: string;

  /** The message to be processed by the DWN server, which can be a serializable DWN message. */
  message: SerializableDwnMessage | any;

  /** The DID of the target to which the message is addressed. */
  targetDid: string;
}

/**
 * Represents the JSON RPC response from a DWN server to a request, combining the results of various
 * DWN operations.
 */
export type DwnRpcResponse = UnionMessageReply & RecordsReadReply;

export type RpcStatus = {
  code: number;
  message: string;
};

export interface SerializableDwnMessage {
  toJSON(): string;
}

export interface Web5Rpc extends DwnRpc, DidRpc {}

/**
 * Client used to communicate with Dwn Servers
 */
export class Web5RpcClient implements Web5Rpc {
  private transportClients: Map<string, Web5Rpc>;

  constructor(clients: Web5Rpc[] = []) {
    this.transportClients = new Map();

    // include http client as default. can be overwritten for 'http:' or 'https:' if instantiator provides
    // their own.
    clients = [new HttpWeb5RpcClient(), ...clients];

    for (let client of clients) {
      for (let transportScheme of client.transportProtocols) {
        this.transportClients.set(transportScheme, client);
      }
    }
  }

  get transportProtocols(): string[] {
    return Array.from(this.transportClients.keys());
  }

  async sendDidRequest(request: DidRpcRequest): Promise<DidRpcResponse> {
    // URL() will throw if provided `url` is invalid.
    const url = new URL(request.url);

    const transportClient = this.transportClients.get(url.protocol);
    if (!transportClient) {
      const error = new Error(`no ${url.protocol} transport client available`);
      error.name = 'NO_TRANSPORT_CLIENT';

      throw error;
    }

    return transportClient.sendDidRequest(request);
  }

  sendDwnRequest(request: DwnRpcRequest): Promise<DwnRpcResponse> {
    // will throw if url is invalid
    const url = new URL(request.dwnUrl);

    const transportClient = this.transportClients.get(url.protocol);
    if (!transportClient) {
      const error = new Error(`no ${url.protocol} transport client available`);
      error.name = 'NO_TRANSPORT_CLIENT';

      throw error;
    }

    return transportClient.sendDwnRequest(request);
  }
}

// TODO: move to dwn-server repo. i wrote this here for expediency

/**
 * HTTP client that can be used to communicate with Dwn Servers
 */
class HttpDwnRpcClient implements DwnRpc {
  get transportProtocols() { return ['http:', 'https:']; }

  async sendDwnRequest(request: DwnRpcRequest): Promise<DwnRpcResponse> {
    const requestId = cryptoUtils.randomUuid();
    const jsonRpcRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
      target  : request.targetDid,
      message : request.message
    });

    const fetchOpts = {
      method  : 'POST',
      headers : {
        'dwn-request': JSON.stringify(jsonRpcRequest)
      }
    };

    if (request.data) {
      // @ts-expect-error TODO: REMOVE
      fetchOpts.headers['content-type'] = 'application/octet-stream';
      // @ts-expect-error TODO: REMOVE
      fetchOpts['body'] = request.data;
    }

    const resp = await fetch(request.dwnUrl, fetchOpts);
    let dwnRpcResponse: JsonRpcResponse;

    // check to see if response is in header first. if it is, that means the response is a ReadableStream
    let dataStream;
    const { headers } = resp;
    if (headers.has('dwn-response')) {
      // @ts-expect-error TODO: REMOVE
      const jsonRpcResponse = parseJson(headers.get('dwn-response')) as JsonRpcResponse;

      if (jsonRpcResponse == null) {
        throw new Error(`failed to parse json rpc response. dwn url: ${request.dwnUrl}`);
      }

      dataStream = resp.body;
      dwnRpcResponse = jsonRpcResponse;
    } else {
      // TODO: wonder if i need to try/catch this?
      const responseBody = await resp.text();
      dwnRpcResponse = JSON.parse(responseBody);
    }

    if (dwnRpcResponse.error) {
      const { code, message } = dwnRpcResponse.error;
      throw new Error(`(${code}) - ${message}`);
    }

    const { reply } = dwnRpcResponse.result;
    if (dataStream) {
      reply['record']['data'] = dataStream;
    }

    return reply as DwnRpcResponse;
  }
}

class HttpWeb5RpcClient extends HttpDwnRpcClient implements Web5Rpc {
  async sendDidRequest(request: DidRpcRequest): Promise<DidRpcResponse> {
    const requestId = cryptoUtils.randomUuid();
    const jsonRpcRequest = createJsonRpcRequest(requestId, request.method, {
      data: request.data
    });

    const httpRequest = new Request(request.url, {
      method  : 'POST',
      headers : {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(jsonRpcRequest),
    });

    let jsonRpcResponse: JsonRpcResponse;

    try {
      const response = await fetch(httpRequest);

      if (response.ok) {
        jsonRpcResponse = await response.json();

        // If the response is an error, throw an error.
        if (jsonRpcResponse.error) {
          const { code, message } = jsonRpcResponse.error;
          throw new Error(`JSON RPC (${code}) - ${message}`);
        }
      } else {
        throw new Error(`HTTP (${response.status}) - ${response.statusText}`);
      }
    } catch (error: any) {
      throw new Error(`Error encountered while processing response from ${request.url}: ${error.message}`);
    }

    return jsonRpcResponse.result as DidRpcResponse;
  }
}