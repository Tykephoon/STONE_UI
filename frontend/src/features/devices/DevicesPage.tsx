/**
 * Device overview — read-only.
 *
 * There is no "register device" button because there is no API route behind
 * one. With no user accounts, an HTTP endpoint that minted device keys would be
 * usable by anyone who found the API, and the ingest credential would stop
 * meaning anything. Provisioning is a server-side command instead; this page
 * shows what exists and how to add more.
 */
import { listDevices } from '../../api/devices';
import { ChipIcon, RefreshIcon } from '../../components/layout/Icons';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Badge, EmptyState, ErrorState, Skeleton, StatusDot } from '../../components/ui/Feedback';
import { config } from '../../config';
import { useAsync } from '../../hooks/useAsync';
import { formatCount } from '../../lib/format';
import { formatDateTime, formatRelative } from '../../lib/time';
import styles from './DevicesPage.module.css';

/** A device is considered online if it posted within this window. */
const ONLINE_THRESHOLD_MS = 10 * 60_000;

const PROVISIONING = `# on the server, or: fly ssh console -C "node /app/dist/scripts/device.js list"

npm run device -- list
npm run device -- add "Pico-01 · Trail Rig" --notes "BME280 + MPU-6050"
npm run device -- rotate dev_xxxxxxxxxxxxxxxxxx
npm run device -- remove dev_xxxxxxxxxxxxxxxxxx`;

const INGEST_EXAMPLE = `POST ${config.apiBaseUrl}/api/ingest
Authorization: Bearer stk_<your-device-key>
Content-Type: application/json

{
  "recorded_at": "2026-09-19T10:04:00Z",
  "latitude": 42.3398,
  "longitude": -71.0892,
  "altitude_m": 14.2,
  "gps_accuracy_m": 4.5,
  "tires": {
    "front_left":  { "pressure_kpa": 228.4, "temp_c": 31.2 },
    "front_right": { "pressure_kpa": 229.1, "temp_c": 30.8 },
    "rear_left":   { "pressure_kpa": 235.0, "temp_c": 33.4 },
    "rear_right":  { "pressure_kpa": 234.2, "temp_c": 33.1 }
  },
  "sensors": {
    "ambient_temp_c": 18.4,
    "humidity_pct": 61.2,
    "barometric_pressure_hpa": 1014.2,
    "accel_x_g": 0.02,
    "accel_y_g": -0.01,
    "accel_z_g": 1.00,
    "battery_voltage_v": 12.4
  },
  "firmware": "1.4.2"
}`;

export function DevicesPage(): JSX.Element {
  const state = useAsync((signal) => listDevices(signal), []);
  const devices = state.data?.devices ?? [];

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Devices</h1>
          <p className={styles.subtitle}>
            Each device authenticates to the ingest endpoint with its own key.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={state.reload}
          isLoading={state.isFetching && !state.isLoading}
          iconLeft={<RefreshIcon size={15} />}
        >
          Refresh
        </Button>
      </header>

      {state.error ? (
        <ErrorState error={state.error} onRetry={state.reload} />
      ) : state.isLoading ? (
        <div className={styles.list}>
          {Array.from({ length: 2 }, (_, index) => (
            <Skeleton key={index} height={132} radius="var(--radius-lg)" />
          ))}
        </div>
      ) : devices.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ChipIcon size={22} />}
            title="No devices registered"
            description="Register one on the server with the command below. You will be shown a key once; put it on the device and readings will start appearing on the dashboard."
          />
        </Card>
      ) : (
        <div className={styles.list}>
          {devices.map((device) => {
            const online =
              device.last_seen_at !== null &&
              Date.now() - Date.parse(device.last_seen_at) < ONLINE_THRESHOLD_MS;

            return (
              <Card key={device.id}>
                <CardHeader
                  title={device.name}
                  level={3}
                  subtitle={
                    <span className={styles.statusLine}>
                      <StatusDot tone={online ? 'good' : 'neutral'} pulse={online} />
                      {online ? 'Online' : 'Idle'}
                      {device.last_seen_at && (
                        <>
                          <span className={styles.separator}>·</span>
                          <span title={formatDateTime(device.last_seen_at)}>
                            last posted {formatRelative(device.last_seen_at)}
                          </span>
                        </>
                      )}
                    </span>
                  }
                />
                <CardBody>
                  {device.notes && <p className={styles.notes}>{device.notes}</p>}

                  <dl className={styles.meta}>
                    <div>
                      <dt>Readings</dt>
                      <dd>{formatCount(device.reading_count)}</dd>
                    </div>
                    <div>
                      <dt>Device id</dt>
                      <dd className={styles.mono}>{device.id}</dd>
                    </div>
                    <div>
                      <dt>Key prefix</dt>
                      <dd className={styles.mono}>{device.key_prefix}…</dd>
                    </div>
                    <div>
                      <dt>Registered</dt>
                      <dd>{formatDateTime(device.created_at)}</dd>
                    </div>
                    <div>
                      <dt>Key rotated</dt>
                      <dd>
                        {device.key_rotated_at ? formatDateTime(device.key_rotated_at) : 'Never'}
                      </dd>
                    </div>
                  </dl>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader
          title="Managing devices"
          subtitle="Provisioning happens on the server, not through this page"
          level={3}
          actions={<Badge tone="accent">CLI only</Badge>}
        />
        <CardBody>
          <p className={styles.helpText}>
            A device key is the only credential this system has, and it is what stops anyone who
            finds the API from writing readings into your database. Minting one therefore requires
            access to the server rather than access to the API — there is deliberately no HTTP route
            that creates, rotates, or deletes a device.
          </p>
          <pre className={styles.snippet}>{PROVISIONING}</pre>
          <p className={styles.helpText}>
            Keys are shown once and stored only as a hash, so a lost key is rotated rather than
            recovered. Rotating invalidates the previous key immediately.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Posting readings" subtitle="What a device needs to send" level={3} />
        <CardBody>
          <p className={styles.helpText}>
            Devices authenticate with their key as a bearer token. Send one reading, or a batch
            under a <code>readings</code> array. Unknown fields are preserved rather than dropped
            and appear on the reading detail page.
          </p>
          <pre className={styles.snippet}>{INGEST_EXAMPLE}</pre>
        </CardBody>
      </Card>
    </div>
  );
}
