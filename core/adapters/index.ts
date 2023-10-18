import { ErrorWithCause } from "df/common/errors/errors";
import { BigQueryAdapter } from "df/core/adapters/bigquery";
import { concatenateQueries, Tasks } from "df/core/tasks";
import { dataform } from "df/protos/ts";

export interface IAdapter {
  resolveTarget(target: dataform.ITarget): string;
  normalizeIdentifier(identifier: string): string;

  sqlString(stringContents: string): string;

  publishTasks(
    table: dataform.ITable,
    runConfig: dataform.IRunConfig,
    tableMetadata: dataform.ITableMetadata
  ): Tasks;
  assertTasks(assertion: dataform.IAssertion, projectConfig: dataform.IProjectConfig): Tasks;

  dropIfExists(target: dataform.ITarget, type: dataform.TableMetadata.Type): string;
  baseTableType(enumType: dataform.TableType): dataform.TableMetadata.Type;

  indexAssertion(dataset: string, indexCols: string[]): string;
  rowConditionsAssertion(dataset: string, rowConditions: string[]): string;
}

export type AdapterConstructor<T extends IAdapter> = new (
  projectConfig: dataform.IProjectConfig,
  dataformCoreVersion: string
) => T;

export enum WarehouseType {
  BIGQUERY = "bigquery"
}

export function isWarehouseType(input: any): input is WarehouseType {
  return Object.values(WarehouseType).includes(input);
}

const requiredBigQueryWarehouseProps: Array<keyof dataform.IBigQuery> = ["projectId"];

export const requiredWarehouseProps = {
  [WarehouseType.BIGQUERY]: requiredBigQueryWarehouseProps
};

const registry: { [warehouseType: string]: AdapterConstructor<IAdapter> } = {};

export function register(warehouseType: string, c: AdapterConstructor<IAdapter>) {
  registry[warehouseType] = c;
}

export function create(
  projectConfig: dataform.IProjectConfig,
  dataformCoreVersion: string
): IAdapter {
  if (!registry[projectConfig.warehouse]) {
    throw new Error(`Unsupported warehouse: ${projectConfig.warehouse}`);
  }
  return new registry[projectConfig.warehouse](projectConfig, dataformCoreVersion);
}

register("bigquery", BigQueryAdapter);

export type QueryOrAction = string | dataform.Table | dataform.Operation | dataform.Assertion;

export interface IValidationQuery {
  query?: string;
  incremental?: boolean;
}
export function collectEvaluationQueries(
  queryOrAction: QueryOrAction,
  concatenate: boolean,
  queryModifier: (mod: string) => string = (q: string) => q
): IValidationQuery[] {
  // TODO: The prefix method (via `queryModifier`) is a bit sketchy. For example after
  // attaching the `explain` prefix, a table or operation could look like this:
  // ```
  // explain
  // -- Delete the temporary table, if it exists (perhaps from a previous run).
  // DROP TABLE IF EXISTS "df_integration_test"."load_from_s3_temp" CASCADE;
  // ```
  // which is invalid because the `explain` is interrupted by a comment.
  const validationQueries = new Array<IValidationQuery>();
  if (typeof queryOrAction === "string") {
    validationQueries.push({ query: queryModifier(queryOrAction) });
  } else {
    try {
      if (queryOrAction instanceof dataform.Table) {
        if (queryOrAction.enumType === dataform.TableType.INCREMENTAL) {
          const incrementalTableQueries = queryOrAction.incrementalPreOps.concat(
            queryOrAction.incrementalQuery,
            queryOrAction.incrementalPostOps
          );
          if (concatenate) {
            validationQueries.push({
              query: concatenateQueries(incrementalTableQueries, queryModifier),
              incremental: true
            });
          } else {
            incrementalTableQueries.forEach(q =>
              validationQueries.push({ query: queryModifier(q), incremental: true })
            );
          }
        }
        const tableQueries = queryOrAction.preOps.concat(
          queryOrAction.query,
          queryOrAction.postOps
        );
        if (concatenate) {
          validationQueries.push({
            query: concatenateQueries(tableQueries, queryModifier)
          });
        } else {
          tableQueries.forEach(q => validationQueries.push({ query: queryModifier(q) }));
        }
      } else if (queryOrAction instanceof dataform.Operation) {
        if (concatenate) {
          validationQueries.push({
            query: concatenateQueries(queryOrAction.queries, queryModifier)
          });
        } else {
          queryOrAction.queries.forEach(q => validationQueries.push({ query: queryModifier(q) }));
        }
      } else if (queryOrAction instanceof dataform.Assertion) {
        validationQueries.push({ query: queryModifier(queryOrAction.query) });
      } else {
        throw new Error("Unrecognized evaluate type.");
      }
    } catch (e) {
      throw new ErrorWithCause(`Error building tasks for evaluation. ${e.message}`, e);
    }
  }
  return validationQueries
    .map(validationQuery => ({ query: validationQuery.query.trim(), ...validationQuery }))
    .filter(validationQuery => !!validationQuery.query);
}
