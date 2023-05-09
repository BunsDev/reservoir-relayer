import * as Sdk from "@reservoir0x/sdk";
import axios, { AxiosRequestConfig } from "axios";
import pLimit from "p-limit";

import { db, pgp } from "../../common/db";
import { addToRelayOrdersQueue } from "../relay-orders";
import { logger } from "../../common/logger";
import { Seaport, SeaportOrder } from "../../utils/seaport";
import _ from "lodash";
import { fromUnixTime, format } from "date-fns";
import { config } from "../../config";
import {
  FetchOffersCollection,
  FetchOffersCollections,
} from "../../models/fetch-offers-collections";

const MAX_FETCH_OFFERS_COLLECTIONS = 1000;

export const fetchOrders = async (
  side: "sell" | "buy",
  details?: {
    apiKey?: string;
    overrideBaseUrl?: string;
    contract?: string;
    maxOrders?: number;
  }
) => {
  logger.info("fetch_orders_seaport", `Seaport - Start. side=${side}`);

  const seaport = new Seaport();

  let cursor = null;
  let limit = 50;
  let total = 0;

  let done = false;
  while (!done && (details?.maxOrders ? total < details.maxOrders : true)) {
    logger.info("fetch_orders_seaport", `Seaport fetch orders. side=${side}, cursor=${cursor}`);

    const url = seaport.buildFetchOrdersURL({
      overrideBaseUrl: details?.overrideBaseUrl,
      contract: details?.contract,
      side,
      orderBy: "created_date",
      orderDirection: "desc",
      limit,
      cursor,
    });

    const options: AxiosRequestConfig = {
      method: "GET",
      url: config.openseaApiUrl || url,
      headers: {
        url,
        [process.env.OPENSEA_API_HEADER ?? "X-API-KEY"]:
          config.chainId !== 5 ? details?.apiKey || config.realtimeOpenseaApiKey : "",
      },
    };

    try {
      const response = await axios.request(options);
      cursor = response.data.next;

      const orders: SeaportOrder[] = response.data.orders;
      if (config.chainId === 10) {
        logger.info("debug", JSON.stringify(orders));
      }
      total += orders.length;

      const parsedOrders: {
        kind: "seaport-v1.4" | "seaport-v1.5";
        data: Sdk.SeaportBase.Types.OrderComponents;
      }[] = [];

      const values: any[] = [];
      const handleOrder = async (order: SeaportOrder) => {
        const parsed = await seaport.parseSeaportOrder(order);
        if (parsed) {
          parsedOrders.push({
            kind: parsed.kind,
            data: parsed.order.params as any,
          });
        }

        values.push({
          hash: order.order_hash.toLowerCase(),
          target:
            parsed?.order.getInfo()?.contract.toLowerCase() ||
            order.protocol_data.parameters.offer[0].token.toLowerCase(),
          maker: order.maker.address.toLowerCase(),
          created_at: new Date(order.created_date),
          data: order.protocol_data as any,
          source: "opensea",
        });
      };

      const plimit = pLimit(20);
      await Promise.all(orders.map((order) => plimit(() => handleOrder(order))));

      if (values.length) {
        const columns = new pgp.helpers.ColumnSet(
          ["hash", "target", "maker", "created_at", "data", "source"],
          { table: "orders_v23" }
        );

        const result = await db.manyOrNone(
          pgp.helpers.insert(values, columns) + " ON CONFLICT DO NOTHING RETURNING 1"
        );

        // If result is empty, all transactions already exists
        if (_.isEmpty(result)) {
          const lastOrder = _.last(orders);

          if (lastOrder) {
            logger.info(
              "fetch_orders_seaport",
              `Seaport empty result. side=${side}, cursor=${cursor}, reached to=${lastOrder.created_date}`
            );
          }

          done = true;
        }

        if (orders.length) {
          logger.info(
            "fetch_orders_seaport",
            `Seaport synced up to ${orders[orders.length - 1].created_date}`
          );
        }
      }

      if (parsedOrders.length) {
        await addToRelayOrdersQueue(parsedOrders, true);
      }

      logger.info(
        "fetch_orders_seaport",
        `Seaport - Batch done. side=${side}, cursor=${cursor} Got ${orders.length} orders`
      );
    } catch (error: any) {
      logger.error(
        "fetch_orders_seaport",
        `Seaport - Error. side=${side}, cursor=${cursor}, url=${url}, apiKey=${details?.apiKey}, realtimeOpenseaApiKey=${config.realtimeOpenseaApiKey}, error=${error}`
      );

      if (error.response?.status === 429) {
        logger.warn(
          "fetch_orders_seaport",
          `Seaport - Rate Limited. side=${side}, cursor=${cursor}, error=${error}`
        );

        if (cursor) {
          logger.warn(
            "fetch_orders_seaport",
            `Seaport - Rate Limited - Retry. side=${side}, cursor=${cursor}, error=${error}`
          );

          await new Promise((resolve) => setTimeout(resolve, 5000));

          continue;
        }
      }

      throw error;
    }
  }

  logger.info("fetch_orders_seaport", `Seaport - Done. side=${side}, total=${total}`);
};

export const fetchAllOrders = async (
  fromTimestamp: number | null = null,
  toTimestamp: number | null = null,
  cursor: string | null = null
) => {
  let formatFromTimestamp = null;
  let formatToTimestamp = null;

  if (fromTimestamp) {
    formatFromTimestamp = format(fromUnixTime(fromTimestamp), "yyyy-MM-dd HH:mm:ss");
  }

  if (toTimestamp) {
    formatToTimestamp = format(fromUnixTime(toTimestamp), "yyyy-MM-dd HH:mm:ss");
  }

  const seaport = new Seaport();
  let limit = 50;

  const url = seaport.buildFetchOrdersURL({
    side: "sell",
    orderBy: "created_date",
    orderDirection: "desc",
    limit,
    cursor,
    listedAfter: fromTimestamp,
    listedBefore: toTimestamp,
  });

  const options: AxiosRequestConfig = {
    method: "GET",
    url: config.openseaApiUrl || url,
    headers: {
      url,
      "x-api-key": config.backfillOpenseaApiKey || "",
    },
  };

  try {
    const response = await axios.request(options);

    const orders: SeaportOrder[] = response.data.orders;
    const parsedOrders: {
      kind: "seaport-v1.4" | "seaport-v1.5";
      data: Sdk.SeaportBase.Types.OrderComponents;
    }[] = [];

    logger.info(
      "fetch_all_orders",
      `Seaport Fetch all orders received ${orders.length} orders fromTimestamp=${formatFromTimestamp}, toTimestamp=${formatToTimestamp}, cursor=${cursor}`
    );

    const values: any[] = [];

    const handleOrder = async (order: SeaportOrder) => {
      const parsed = await seaport.parseSeaportOrder(order);
      if (parsed) {
        parsedOrders.push({
          kind: parsed.kind,
          data: parsed.order.params as any,
        });
      }

      values.push({
        hash: order.order_hash,
        target: (
          parsed?.order.getInfo()?.contract || order.protocol_data.parameters.offer[0].token
        ).toLowerCase(),
        maker: order.maker.address.toLowerCase(),
        created_at: new Date(order.created_date),
        data: order.protocol_data as any,
        source: "opensea",
      });
    };

    const plimit = pLimit(20);
    await Promise.all(orders.map((order) => plimit(() => handleOrder(order))));

    if (values.length) {
      const columns = new pgp.helpers.ColumnSet(
        ["hash", "target", "maker", "created_at", "data", "source"],
        { table: "orders_v23" }
      );

      const result = await db.manyOrNone(
        pgp.helpers.insert(values, columns) + " ON CONFLICT DO NOTHING RETURNING 1"
      );

      // If new listing were recorded
      if (result.length) {
        logger.info(
          "fetch_all_orders",
          `Seaport - fromTimestamp=${formatFromTimestamp}, toTimestamp=${formatToTimestamp}, New listings found=${result.length}, cursor=${cursor}`
        );
      }
    }

    if (parsedOrders.length) {
      await addToRelayOrdersQueue(parsedOrders, true);
    }

    logger.info(
      "fetch_all_orders",
      `Seaport - fromTimestamp=${formatFromTimestamp}, toTimestamp=${formatToTimestamp}, newCursor=${response.data.next} Got ${orders.length} orders`
    );

    return response.data.next;
  } catch (error) {
    throw error;
  }
};

export const fetchListingsBySlug = async (slug: string) => {
  const seaport = new Seaport();

  const url =
    config.chainId === 5
      ? `https://testnets-api.opensea.io/api/v2/listings/collection/${slug}/all`
      : `https://api.opensea.io/api/v2/listings/collection/${slug}/all`;

  try {
    const response = await axios.get(url, {
      headers:
        config.chainId === 5
          ? {}
          : {
              "X-Api-Key": config.realtimeOpenseaApiKey || config.backfillOpenseaApiKey,
            },
      timeout: 20000,
    });

    const orders: SeaportOrder[] = response.data.listings;
    const parsedOrders: {
      kind: "seaport-v1.4" | "seaport-v1.5";
      data: Sdk.SeaportBase.Types.OrderComponents;
    }[] = [];
    const values: any[] = [];

    const handleOrder = async (order: SeaportOrder) => {
      const parsed = await seaport.parseSeaportOrder(order);
      if (parsed) {
        parsedOrders.push({
          kind: parsed.kind,
          data: parsed.order.params as any,
        });
      }

      values.push({
        hash: order.order_hash.toLowerCase(),
        target:
          parsed?.order.getInfo()?.contract.toLowerCase() ||
          order.protocol_data.parameters.offer[0].token.toLowerCase(),
        maker: order.maker.address.toLowerCase(),
        created_at: new Date(order.created_date),
        data: order.protocol_data as any,
        source: "opensea",
      });
    };

    const plimit = pLimit(20);
    await Promise.all(orders.map((order) => plimit(() => handleOrder(order))));

    if (values.length) {
      const columns = new pgp.helpers.ColumnSet(
        ["hash", "target", "maker", "created_at", "data", "source"],
        { table: "orders_v23" }
      );

      const result = await db.manyOrNone(
        pgp.helpers.insert(values, columns) + " ON CONFLICT DO NOTHING RETURNING 1"
      );

      // If result is empty all orders already exists
      if (_.isEmpty(result)) {
        const lastOrder = _.last(orders);

        if (lastOrder) {
          logger.info(
            "fetch_listings_by_slug",
            `Seaport empty result. reached to=${lastOrder.created_date}`
          );
        }
      }
    }

    if (parsedOrders.length) {
      await addToRelayOrdersQueue(parsedOrders, true);
    }

    logger.info(
      "fetch_listings_by_slug",
      `Seaport - Success. slug:${slug}, orders:${orders.length}`
    );
  } catch (error) {
    logger.error("fetch_listings_by_slug", `Seaport - Error. slug:${slug}, error:${error}`);
    throw error;
  }
};

export const fetchCollectionOffers = async (contract: string, tokenId: string, apiKey = "") => {
  const seaport = new Seaport();

  const url =
    config.chainId === 1
      ? `https://api.opensea.io/api/v1/asset/${contract}/${tokenId}/offers`
      : `https://testnets-api.opensea.io/api/v1/asset/${contract}/${tokenId}/offers`;

  try {
    const response = await axios.get(url, {
      headers:
        _.indexOf([1, 137], config.chainId) !== -1
          ? {
              "X-API-KEY": apiKey || config.realtimeOpenseaApiKey || config.backfillOpenseaApiKey,
            }
          : {},
      timeout: 20000,
    });

    const orders: SeaportOrder[] = response.data.seaport_offers;
    const parsedOrders: {
      kind: "seaport-v1.4" | "seaport-v1.5";
      data: Sdk.SeaportBase.Types.OrderComponents;
    }[] = [];
    const values: any[] = [];

    const handleOrder = async (order: SeaportOrder) => {
      const parsed = await seaport.parseSeaportOrder(order);
      if (parsed) {
        parsedOrders.push({
          kind: parsed.kind,
          data: parsed.order.params as any,
        });
      }

      values.push({
        hash: order.order_hash.toLowerCase(),
        target:
          parsed?.order.getInfo()?.contract.toLowerCase() ||
          order.protocol_data.parameters.offer[0].token.toLowerCase(),
        maker: order.maker.address.toLowerCase(),
        created_at: new Date(order.created_date),
        data: order.protocol_data as any,
        source: "opensea",
      });
    };

    const plimit = pLimit(20);
    await Promise.all(orders.map((order) => plimit(() => handleOrder(order))));

    if (values.length) {
      const columns = new pgp.helpers.ColumnSet(
        ["hash", "target", "maker", "created_at", "data", "source"],
        { table: "orders_v23" }
      );

      const result = await db.manyOrNone(
        pgp.helpers.insert(values, columns) + " ON CONFLICT DO NOTHING RETURNING 1"
      );

      // If result is empty, all transactions already exists
      if (_.isEmpty(result)) {
        const lastOrder = _.last(orders);

        if (lastOrder) {
          logger.info(
            "fetch_collection_offers",
            `Seaport empty result. reached to=${lastOrder.created_date}`
          );
        }
      }
    }

    if (parsedOrders.length) {
      await addToRelayOrdersQueue(parsedOrders, true);
    }

    logger.info(
      "fetch_collection_offers",
      `Seaport - Success. contract:${contract}, tokenId:${tokenId}, orders:${orders.length}`
    );
  } catch (error) {
    throw error;
  }
};

export const getCollectionsToFetchOffers = async () => {
  try {
    const fetchOffersCollections = new FetchOffersCollections("opensea");
    const fetchOffersCollectionsCount = await fetchOffersCollections.count();

    if (fetchOffersCollectionsCount === 0) {
      await refreshCollectionsToFetchOffers();
    }

    return await fetchOffersCollections.getAll();
  } catch (error) {
    logger.error("get_collections", `Failed. error:${error}`);
    return [];
  }
};

export const refreshCollectionsToFetchOffers = async () => {
  try {
    let collections = [];
    let continuation = null;

    logger.info("refresh_collections", `Start. max:${MAX_FETCH_OFFERS_COLLECTIONS}`);

    const headers = {};
    if (process.env.INDEXER_API_KEY) {
      (headers as any)["X-Api-Key"] = process.env.INDEXER_API_KEY;
    }

    for (let i = 0; i < Math.ceil(MAX_FETCH_OFFERS_COLLECTIONS / 20); i++) {
      const response: any = await axios.get(
        continuation
          ? `${process.env.BASE_INDEXER_LITE_API_URL}/collections/v5?limit=20&sortBy=30DayVolume&continuation=${continuation}`
          : `${process.env.BASE_INDEXER_LITE_API_URL}/collections/v5?limit=20&sortBy=30DayVolume`,
        {
          timeout: 20000,
          headers,
        }
      );

      collections.push(...response.data.collections);
      continuation = response.data.continuation;

      if (response.data.collections.length < 20) {
        break;
      }
    }

    if (collections.length) {
      const fetchOffersCollectionToAdd: FetchOffersCollection[] = [];

      const headers = {};
      if (process.env.INDEXER_API_KEY) {
        (headers as any)["X-Api-Key"] = process.env.INDEXER_API_KEY;
      }

      for (const collection of collections) {
        try {
          const response = await axios.get(
            `${process.env.BASE_INDEXER_LITE_API_URL}/tokens/ids/v1?collection=${collection.id}&limit=50`,
            {
              timeout: 20000,
              headers,
            }
          );

          // OpenSea returns 404 on certain tokens, so we get 50 and choose a random token id.
          fetchOffersCollectionToAdd.push({
            collection: collection.id,
            contract: collection.primaryContract,
            tokenId: _.sample(response.data.tokens),
          });
        } catch (error) {
          logger.error(
            "refresh_collections",
            `Failed to refresh collection. collectionId=${collection.id}, error:${error}`
          );
        }
      }

      const fetchOffersCollections = new FetchOffersCollections("opensea");
      await fetchOffersCollections.add(fetchOffersCollectionToAdd, true);
    }
  } catch (error) {
    logger.error("refresh_collections", `Failed. error:${error}`);
  }
};
