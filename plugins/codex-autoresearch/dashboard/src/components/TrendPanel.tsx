import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { buildChart } from "../model";
import type { DashboardReadout, SessionSegment } from "../types";
import { useUrlParam } from "../hooks/useUrlState";
import { ExperimentModal } from "./trend/ExperimentModal";
import { MetricDetails } from "./trend/MetricDetails";
import {
  ChartControls,
  ChartDataList,
  StatusLegend,
  TrendChartFigure,
} from "./trend/TrendChartFigure";
import { restoreChartPointFocus, type ChartPointOpener } from "./trend/focus";
import {
  AXIS_MODES,
  buildChartData,
  buildTrendChartState,
  VALUE_MODES,
  type ChartDatum,
  type ValueMode,
  type AxisMode,
} from "./trend/shared";

interface TrendPanelProps {
  session: SessionSegment;
  readout: DashboardReadout;
  detailsDefaultOpen?: boolean;
  chartHeight?: number;
}

export function TrendPanel({
  session,
  readout,
  detailsDefaultOpen = true,
  chartHeight = 350,
}: TrendPanelProps) {
  const [valueModeParam, setValueMode] = useUrlParam("value", VALUE_MODES, "value");
  const [axisModeParam, setAxisMode] = useUrlParam("axis", AXIS_MODES, "iteration");
  const valueMode = valueModeParam as ValueMode;
  const axisMode = axisModeParam as AxisMode;
  const [selectedPoint, setSelectedPoint] = useState<ChartDatum | null>(null);
  const [restoreFocusTick, setRestoreFocusTick] = useState(0);
  const modalOpenerRef = useRef<ChartPointOpener>(null);
  const modalOpenerSelectorRef = useRef<string>("");
  const chart = useMemo(() => buildChart(session, readout), [readout, session]);
  const chartData = useMemo(() => buildChartData(chart, readout), [chart, readout]);
  const chartState = useMemo(
    () => buildTrendChartState({ axisMode, chart, chartData, readout, valueMode }),
    [axisMode, chart, chartData, readout, valueMode],
  );
  const detailPoint = selectedPoint || chartData.at(-1) || null;
  const openPoint = (point: ChartDatum, opener: ChartPointOpener) => {
    modalOpenerRef.current = opener;
    modalOpenerSelectorRef.current = `[data-chart-run="${point.runNumber}"]`;
    setSelectedPoint(point);
  };
  const closePoint = () => {
    flushSync(() => {
      setSelectedPoint(null);
    });
    setRestoreFocusTick((value) => value + 1);
  };
  useEffect(() => {
    if (!restoreFocusTick) return;
    restoreChartPointFocus(modalOpenerRef.current, modalOpenerSelectorRef.current);
  }, [restoreFocusTick]);
  return (
    <section
      className="panel trend-panel"
      id="trend-panel"
      aria-label="Evidence trail"
      tabIndex={-1}
    >
      <div className="panel-head">
        <div>
          <p className="eyebrow">Evidence trail</p>
          <h2>Packet trend</h2>
        </div>
        <ChartControls
          axisMode={axisMode}
          metricDefinition={readout.metricDefinition}
          setAxisMode={setAxisMode}
          setValueMode={setValueMode}
          valueMode={valueMode}
        />
        <span id="chart-note" className="panel-note">
          {chart.note}
        </span>
      </div>

      <StatusLegend />

      <TrendChartFigure
        chart={chart}
        chartData={chartData}
        chartHeight={chartHeight}
        chartState={chartState}
        onPointSelect={openPoint}
        readout={readout}
        valueMode={valueMode}
      />

      <p id="trend-chart-summary" className="sr-summary">
        {chart.summary}
      </p>
      <ChartDataList chartData={chartData} />

      {detailsDefaultOpen ? (
        <MetricDetails readout={readout} session={session} point={detailPoint} />
      ) : (
        <details className="metric-details-disclosure">
          <summary>How this metric is computed</summary>
          <MetricDetails readout={readout} session={session} point={detailPoint} />
        </details>
      )}

      {selectedPoint && (
        <ExperimentModal
          point={selectedPoint}
          valueMode={valueMode}
          readout={readout}
          restoreFocusSelector={modalOpenerSelectorRef.current}
          onClose={closePoint}
        />
      )}
    </section>
  );
}
