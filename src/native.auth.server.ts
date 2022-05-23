import axios from "axios";
import { UserPublicKey, UserVerifier } from "@elrondnetwork/erdjs-walletcore/out";
import { Address, SignableMessage } from "@elrondnetwork/erdjs/out";
import { NativeAuthHostNotAcceptedError } from "./entities/errors/native.auth.host.not.accepted.error";
import { NativeAuthInvalidBlockHashError } from "./entities/errors/native.auth.invalid.block.hash.error";
import { NativeAuthInvalidSignatureError } from "./entities/errors/native.auth.invalid.signature.error";
import { NativeAuthTokenExpiredError } from "./entities/errors/native.auth.token.expired.error";
import { NativeAuthServerConfig } from "./entities/native.auth.server.config";
import { NativeAuthSignature } from "./native.auth.signature";
import { NativeAuthCacheInterface } from "./native.auth.cache.interface";
import { NativeAuthResult } from "./entities/native.auth.result";

export class NativeAuthServer {
  config: NativeAuthServerConfig;

  constructor(
    config?: Partial<NativeAuthServerConfig>,
  ) {
    this.config = Object.assign(new NativeAuthServerConfig(), config);
  }

  async validate(accessToken: string): Promise<NativeAuthResult> {
    const [address, body, signature] = accessToken.split('.');
    const parsedAddress = this.decode(address);
    const parsedBody = this.decode(body);
    const [host, hash, ttl, extraInfo] = parsedBody.split('.');
    const parsedExtraInfo = JSON.parse(this.decode(extraInfo));

    if (this.config.acceptedHosts.length > 0 && !this.config.acceptedHosts.includes(host)) {
      throw new NativeAuthHostNotAcceptedError();
    }

    const blockTimestamp = await this.getBlockTimestamp(hash);
    if (!blockTimestamp) {
      throw new NativeAuthInvalidBlockHashError();
    }

    const currentBlockTimestamp = await this.getCurrentBlockTimestamp();

    const expires = blockTimestamp + Number(ttl);
    const isTokenExpired = expires < currentBlockTimestamp;
    if (isTokenExpired) {
      throw new NativeAuthTokenExpiredError();
    }

    const signedMessage = `${parsedAddress}${parsedBody}{}`;
    const signableMessage = new SignableMessage({
      address: new Address(parsedAddress),
      message: Buffer.from(signedMessage, 'utf8'),
      signature: new NativeAuthSignature(signature),
    });

    const publicKey = new UserPublicKey(
      Address.fromString(parsedAddress).pubkey(),
    );

    const verifier = new UserVerifier(publicKey);
    const valid = verifier.verify(signableMessage);

    if (!valid) {
      throw new NativeAuthInvalidSignatureError();
    }

    const result = new NativeAuthResult({
      issued: blockTimestamp,
      expires,
      address: parsedAddress,
      extraInfo: parsedExtraInfo,
    });

    // if empty object, delete extraInfo (e30 = encoded '{}')
    if (extraInfo === 'e30') {
      delete result.extraInfo;
    }

    return result;
  }

  private async getCurrentBlockTimestamp(): Promise<number> {
    if (this.config.cache) {
      const timestamp = await this.config.cache.getValue<number>('block:timestamp:latest');
      if (timestamp) {
        return timestamp;
      }
    }

    const response = await axios.get(`${this.config.apiUrl}/blocks?size=1&fields=timestamp`);
    const timestamp = Number(response.data[0].timestamp);

    if (this.config.cache) {
      await this.config.cache.setValue('block:timestamp:latest', timestamp, 6);
    }

    return timestamp;
  }

  private async getBlockTimestamp(hash: string): Promise<number | undefined> {
    if (this.config.cache) {
      const timestamp = await this.config.cache.getValue<number>(`block:timestamp:${hash}`);
      if (timestamp) {
        return timestamp;
      }
    }

    try {
      const { data: timestamp } = await axios.get(`${this.config.apiUrl}/blocks/${hash}?extract=timestamp`);

      if (this.config.cache) {
        await this.config.cache.setValue<number>(`block:timestamp:${hash}`, Number(timestamp), this.config.maxExpirySeconds);
      }

      return Number(timestamp);
    } catch (error) {
      // @ts-ignore
      if (error.response?.status === 404) {
        return undefined;
      }

      throw error;
    }
  }

  private decode(str: string) {
    return Buffer.from(str, 'base64').toString('ascii');
  }
}
