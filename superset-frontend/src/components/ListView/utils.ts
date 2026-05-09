/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { useEffect, useMemo, useState, ReactNode, SyntheticEvent } from 'react';
import {
  CellProps,
  Column,
  HeaderProps,
  useFilters,
  usePagination,
  useRowSelect,
  useRowState,
  useSortBy,
  useTable,
} from 'react-table';

import {
  NumberParam,
  StringParam,
  useQueryParams,
  QueryParamConfig,
} from 'use-query-params';

import rison from 'rison';
import { isEqual } from 'lodash';
import {
  ListViewFetchDataConfig as FetchDataConfig,
  ListViewFilter as Filter,
  ListViewFilterValue as FilterValue,
  InnerFilterValue,
  InternalFilter,
  SortColumn,
  ViewModeType,
} from './types';

type RisonParamData = Record<string, InnerFilterValue>;

// Define custom RisonParam for proper encoding/decoding; note that
// %, &, +, and # must be encoded to avoid breaking the url
const RisonParam: QueryParamConfig<
  RisonParamData | null | undefined,
  RisonParamData | undefined
> = {
  encode: (data?: RisonParamData | null) => {
    if (data === undefined || data === null) return undefined;

    const cleanData = JSON.parse(
      JSON.stringify(data, (_key, value) =>
        value === undefined ? null : value,
      ),
    );

    return rison
      .encode(cleanData)
      .replace(/%/g, '%25')
      .replace(/&/g, '%26')
      .replace(/\+/g, '%2B')
      .replace(/#/g, '%23');
  },
  decode: (dataStr?: string | string[]) =>
    dataStr === undefined || Array.isArray(dataStr)
      ? undefined
      : (rison.decode(dataStr) as RisonParamData),
};

export const SELECT_WIDTH = 176;
export const RANGE_WIDTH = 300;
export const WIDER_DROPDOWN_WIDTH = '300px';

export class ListViewError extends Error {
  name = 'ListViewError';
}

// removes element from a list, returns new list
export function removeFromList<T>(list: T[], index: number): T[] {
  return list.filter((_, i) => index !== i);
}

// apply update to elements of object list, returns new list
function updateInList<T>(list: T[], index: number, update: Partial<T>): T[] {
  const element = list[index];

  return [
    ...list.slice(0, index),
    { ...element, ...update } as T,
    ...list.slice(index + 1),
  ];
}

type QueryFilterState = {
  [id: string]: FilterValue['value'];
};

function mergeCreateFilterValues(list: Filter[], updateObj: QueryFilterState) {
  return list.map(({ id, urlDisplay, operator }) => {
    const currentFilterId = urlDisplay || id;
    const update = updateObj[currentFilterId];

    return { id, urlDisplay, operator, value: update };
  });
}

// convert filters from UI objects to data objects
export function convertFilters(fts: InternalFilter[]): FilterValue[] {
  return fts
    .filter(
      f =>
        !(
          typeof f.value === 'undefined' ||
          (Array.isArray(f.value) && !f.value.length)
        ),
    )
    .flatMap(({ value, operator, id }) => {
      // handle between filter using 2 api filters
      if (operator === 'between' && Array.isArray(value)) {
        return [
          {
            value: value[0],
            operator: 'gt',
            id,
          },
          {
            value: value[1],
            operator: 'lt',
            id,
          },
        ];
      }
      return {
        value,
        operator,
        id,
      };
    });
}

// convertFilters but to handle new decoded rison format
export function convertFiltersRison(
  filterObj: Record<string, InnerFilterValue>,
  list: Filter[],
): FilterValue[] {
  const filters: FilterValue[] = [];
  const refs: Record<string, FilterValue> = {};

  Object.keys(filterObj).forEach(id => {
    const filter: FilterValue = {
      id,
      value: filterObj[id],
      // operator: filterObj[id][1], // TODO: can probably get rid of this
    };

    refs[id] = filter;
    filters.push(filter);
  });

  // Add operators from filter list
  list.forEach(value => {
    const currentFilterId = value.urlDisplay || value.id;
    const filter = refs[currentFilterId];

    if (filter) {
      filter.operator = value.operator;
      filter.id = value.id;
    }
  });

  return filters;
}

export function extractInputValue(
  inputType: Filter['input'],
  event: SyntheticEvent<HTMLInputElement>,
) {
  if (!inputType || inputType === 'text') {
    return event.currentTarget.value;
  }
  if (inputType === 'checkbox') {
    return event.currentTarget.checked;
  }

  return null;
}

interface UseListViewConfig<D extends object = object> {
  fetchData: (conf: FetchDataConfig) => void;
  columns: Column<D>[];
  data: D[];
  count: number;
  initialPageSize: number;
  initialSort?: SortColumn[];
  bulkSelectMode?: boolean;
  initialFilters?: Filter[];
  bulkSelectColumnConfig?: {
    id: string;
    Header: (conf: HeaderProps<D>) => ReactNode;
    Cell: (conf: CellProps<D>) => ReactNode;
  };
  renderCard?: boolean;
  defaultViewMode?: ViewModeType;
}

interface ListViewQueryParams {
  filters?: Record<string, InnerFilterValue>;
  pageIndex: number;
  sortColumn?: string;
  sortOrder?: 'asc' | 'desc';
  viewMode?: ViewModeType;
}

export function useListViewState<D extends object = object>({
  fetchData,
  columns,
  data,
  count,
  initialPageSize,
  initialFilters = [],
  initialSort = [],
  bulkSelectMode = false,
  bulkSelectColumnConfig,
  renderCard = false,
  defaultViewMode = 'card',
}: UseListViewConfig<D>) {
  const [query, setQuery] = useQueryParams({
    filters: RisonParam,
    pageIndex: NumberParam,
    sortColumn: StringParam,
    sortOrder: StringParam,
    viewMode: StringParam,
  });

  const initialSortBy = useMemo(
    () =>
      query.sortColumn && query.sortOrder
        ? [{ id: query.sortColumn, desc: query.sortOrder === 'desc' }]
        : initialSort,
    [initialSort, query.sortColumn, query.sortOrder],
  );

  const initialState = {
    filters: query.filters
      ? convertFiltersRison(query.filters, initialFilters)
      : [],
    pageIndex: query.pageIndex || 0,
    pageSize: initialPageSize,
    sortBy: initialSortBy,
  };

  const [viewMode, setViewMode] = useState<ViewModeType>(
    (query.viewMode as ViewModeType) ||
      (renderCard ? defaultViewMode : 'table'),
  );

  const columnsWithSelect = useMemo<Column<D>[]>(() => {
    // add exact filter type so filters with falsy values are not filtered out
    const columnsWithFilter = columns.map(f => ({ ...f, filter: 'exact' }));
    return bulkSelectMode && bulkSelectColumnConfig
      ? [bulkSelectColumnConfig, ...columnsWithFilter]
      : columnsWithFilter;
  }, [bulkSelectMode, bulkSelectColumnConfig, columns]);

  const {
    getTableProps,
    getTableBodyProps,
    headerGroups,
    rows,
    prepareRow,
    canPreviousPage,
    canNextPage,
    pageCount,
    gotoPage,
    setAllFilters,
    setSortBy,
    selectedFlatRows,
    toggleAllRowsSelected,
    state: { pageIndex, pageSize, sortBy, filters },
  } = useTable<D>(
    {
      columns: columnsWithSelect,
      data,
      disableFilters: true,
      disableSortRemove: true,
      initialState,
      manualFilters: true,
      manualPagination: true,
      manualSortBy: true,
      autoResetFilters: false,
      pageCount: Math.ceil(count / initialPageSize),
      count,
    },
    useFilters,
    useSortBy,
    usePagination,
    useRowState,
    useRowSelect,
  );

  const [internalFilters, setInternalFilters] = useState<InternalFilter[]>(
    query.filters && initialFilters.length
      ? mergeCreateFilterValues(initialFilters, query.filters)
      : [],
  );

  useEffect(() => {
    if (initialFilters.length) {
      setInternalFilters(
        mergeCreateFilterValues(
          initialFilters,
          query.filters ? query.filters : {},
        ),
      );
    }
  }, [initialFilters]);

  useEffect(() => {
    // From internalFilters, produce a simplified obj
    const filterObj: Record<string, InnerFilterValue> = {};

    internalFilters.forEach(filter => {
      if (
        filter.value !== undefined &&
        (typeof filter.value !== 'string' || filter.value.length > 0)
      ) {
        const currentFilterId = filter.urlDisplay || filter.id;
        filterObj[currentFilterId] = filter.value;
      }
    });

    const queryParams: ListViewQueryParams = {
      filters: Object.keys(filterObj).length ? filterObj : undefined,
      pageIndex,
    };
    if (sortBy?.[0]?.id !== undefined && sortBy[0].id !== null) {
      queryParams.sortColumn = sortBy[0].id;
      queryParams.sortOrder = sortBy[0].desc ? 'desc' : 'asc';
    }

    if (renderCard) {
      queryParams.viewMode = viewMode;
    }

    const method =
      typeof query.pageIndex !== 'undefined' &&
      queryParams.pageIndex !== query.pageIndex
        ? 'push'
        : 'replace';

    setQuery(queryParams, method);

    fetchData({ pageIndex, pageSize, sortBy, filters });
  }, [fetchData, pageIndex, pageSize, sortBy, filters]);

  useEffect(() => {
    if (!isEqual(initialState.pageIndex, pageIndex)) {
      gotoPage(initialState.pageIndex);
    }
  }, [query]);

  const applyFilterValue = (index: number, value: InnerFilterValue) => {
    setInternalFilters(currentInternalFilters => {
      // skip redundant updates
      if (currentInternalFilters[index].value === value) {
        return currentInternalFilters;
      }

      const update = { ...currentInternalFilters[index], value };
      const updatedFilters = updateInList(
        currentInternalFilters,
        index,
        update,
      );

      setAllFilters(convertFilters(updatedFilters));
      gotoPage(0); // clear pagination on filter
      return updatedFilters;
    });
  };

  return {
    canNextPage,
    canPreviousPage,
    getTableBodyProps,
    getTableProps,
    gotoPage,
    headerGroups,
    pageCount,
    prepareRow,
    rows,
    selectedFlatRows,
    setAllFilters,
    setSortBy,
    state: { pageIndex, pageSize, sortBy, filters, internalFilters, viewMode },
    toggleAllRowsSelected,
    applyFilterValue,
    setViewMode,
    query,
  };
}
