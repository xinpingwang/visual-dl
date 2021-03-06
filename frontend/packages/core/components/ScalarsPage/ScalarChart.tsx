import LineChart, {LineChartRef} from '~/components/LineChart';
import {
    Range,
    ScalarDataset,
    SortingMethod,
    XAxis,
    chartData,
    options as chartOptions,
    nearestPoint,
    range,
    singlePointRange,
    sortingMethodMap,
    tooltip,
    transform,
    xAxisMap
} from '~/resource/scalars';
import React, {FunctionComponent, useCallback, useMemo, useRef, useState} from 'react';
import {rem, size} from '~/utils/style';

import ChartToolbox from '~/components/ChartToolbox';
import {EChartOption} from 'echarts';
import {Run} from '~/types';
import {cycleFetcher} from '~/utils/fetch';
import ee from '~/utils/event';
import {format} from 'd3-format';
import queryString from 'query-string';
import styled from 'styled-components';
import useHeavyWork from '~/hooks/useHeavyWork';
import {useRunningRequest} from '~/hooks/useRequest';
import {useTranslation} from '~/utils/i18n';

const smoothWasm = () =>
    import('@visualdl/wasm').then(({scalar_transform}): typeof transform => params =>
        scalar_transform(params.datasets, params.smoothing)
    );
const rangeWasm = () =>
    import('@visualdl/wasm').then(({scalar_range}): typeof range => params =>
        scalar_range(params.datasets, params.outlier)
    );

const smoothWorker = () => new Worker('~/worker/scalars/smooth.worker.ts', {type: 'module'});
const rangeWorker = () => new Worker('~/worker/scalars/range.worker.ts', {type: 'module'});

const Wrapper = styled.div`
    ${size('100%', '100%')}
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: space-between;

    .echarts td.run .run-indicator {
        ${size(12, 12)}
        display: inline-block;
        border-radius: 6px;
        vertical-align: middle;
        margin-right: 5px;
    }
`;

const StyledLineChart = styled(LineChart)`
    flex-grow: 1;
`;

const Toolbox = styled(ChartToolbox)`
    margin-left: ${rem(20)};
    margin-right: ${rem(20)};
    margin-bottom: ${rem(18)};
`;

const Error = styled.div`
    ${size('100%', '100%')}
    display: flex;
    justify-content: center;
    align-items: center;
`;

enum XAxisType {
    value = 'value',
    log = 'log',
    time = 'time'
}

enum YAxisType {
    value = 'value',
    log = 'log'
}

type ScalarChartProps = {
    cid: symbol;
    runs: Run[];
    tag: string;
    smoothing: number;
    xAxis: XAxis;
    sortingMethod: SortingMethod;
    outlier?: boolean;
    running?: boolean;
    onToggleMaximized?: (maximized: boolean) => void;
};

const ScalarChart: FunctionComponent<ScalarChartProps> = ({
    cid,
    runs,
    tag,
    smoothing,
    xAxis,
    sortingMethod,
    outlier,
    running
}) => {
    const {t, i18n} = useTranslation(['scalars', 'common']);

    const echart = useRef<LineChartRef>(null);

    const {data: datasets, error, loading} = useRunningRequest<(ScalarDataset | null)[]>(
        runs.map(run => `/scalars/list?${queryString.stringify({run: run.label, tag})}`),
        !!running,
        (...urls) => cycleFetcher(urls)
    );

    const [maximized, setMaximized] = useState<boolean>(false);
    const toggleMaximized = useCallback(() => {
        ee.emit('toggle-chart-size', cid, !maximized);
        setMaximized(m => !m);
    }, [cid, maximized]);

    const xAxisType = useMemo(() => (xAxis === 'wall' ? XAxisType.time : XAxisType.value), [xAxis]);

    const [yAxisType, setYAxisType] = useState<YAxisType>(YAxisType.value);
    const toggleYAxisType = useCallback(() => {
        setYAxisType(t => (t === YAxisType.log ? YAxisType.value : YAxisType.log));
    }, [setYAxisType]);

    const transformParams = useMemo(
        () => ({
            datasets: datasets?.map(data => data ?? []) ?? [],
            smoothing
        }),
        [datasets, smoothing]
    );
    const smoothedDatasets = useHeavyWork(smoothWasm, smoothWorker, transform, transformParams) ?? [];

    const rangeParams = useMemo(
        () => ({
            datasets: smoothedDatasets,
            outlier: !!outlier
        }),
        [smoothedDatasets, outlier]
    );
    const yRange = useHeavyWork(rangeWasm, rangeWorker, range, rangeParams);

    const ranges: Record<'x' | 'y', Range | undefined> = useMemo(() => {
        let x: Range | undefined = undefined;
        let y: Range | undefined = yRange;

        // if there is only one point, place it in the middle
        if (smoothedDatasets.length === 1 && smoothedDatasets[0].length === 1) {
            if ([XAxisType.value, XAxisType.log].includes(xAxisType)) {
                x = singlePointRange(smoothedDatasets[0][0][xAxisMap[xAxis]]);
            }
            y = singlePointRange(smoothedDatasets[0][0][2]);
        }
        return {x, y};
    }, [smoothedDatasets, yRange, xAxisType, xAxis]);

    const data = useMemo(
        () =>
            chartData({
                data: smoothedDatasets.slice(0, runs.length),
                runs,
                xAxis
            }),
        [smoothedDatasets, runs, xAxis]
    );

    const maxStepLength = useMemo(
        () => String(Math.max(...smoothedDatasets.map(i => Math.max(...i.map(j => j[1]))))).length,
        [smoothedDatasets]
    );

    const formatter = useCallback(
        (params: EChartOption.Tooltip.Format | EChartOption.Tooltip.Format[]) => {
            const data = Array.isArray(params) ? params[0].data : params.data;
            const step = data[1];
            const points = nearestPoint(smoothedDatasets ?? [], runs, step);
            const sort = sortingMethodMap[sortingMethod];
            return tooltip(sort ? sort(points, data) : points, maxStepLength, i18n);
        },
        [smoothedDatasets, runs, sortingMethod, maxStepLength, i18n]
    );

    const options = useMemo(
        () => ({
            ...chartOptions,
            tooltip: {
                ...chartOptions.tooltip,
                formatter
            },
            xAxis: {
                type: xAxisType,
                ...ranges.x,
                axisPointer: {
                    label: {
                        formatter:
                            xAxisType === XAxisType.time ? undefined : ({value}: {value: number}) => format('.8')(value)
                    }
                }
            },
            yAxis: {
                type: yAxisType,
                ...ranges.y
            }
        }),
        [formatter, ranges, xAxisType, yAxisType]
    );

    // display error only on first fetch
    if (!data && error) {
        return <Error>{t('common:error')}</Error>;
    }

    return (
        <Wrapper>
            <StyledLineChart ref={echart} title={tag} options={options} data={data} loading={loading} zoom />
            <Toolbox
                items={[
                    {
                        icon: 'maximize',
                        activeIcon: 'minimize',
                        tooltip: t('scalars:maximize'),
                        activeTooltip: t('scalars:minimize'),
                        toggle: true,
                        onClick: toggleMaximized
                    },
                    {
                        icon: 'restore-size',
                        tooltip: t('scalars:restore'),
                        onClick: () => echart.current?.restore()
                    },
                    {
                        icon: 'log-axis',
                        tooltip: t('scalars:axis'),
                        toggle: true,
                        onClick: toggleYAxisType
                    },
                    {
                        icon: 'download',
                        tooltip: t('scalars:download-image'),
                        onClick: () => echart.current?.saveAsImage()
                    }
                ]}
            />
        </Wrapper>
    );
};

export default ScalarChart;
