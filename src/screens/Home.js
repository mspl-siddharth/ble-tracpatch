import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  PermissionsAndroid,
  Platform,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { BleManager, ScanMode } from 'react-native-ble-plx';
import { Buffer } from 'buffer';

const manager = new BleManager();

const Home = () => {
  const [devices, setDevices] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [connectedDevice, setConnectedDevice] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [heartRate, setHeartRate] = useState(null);

  let hrSubscription = null;

  // Request runtime permissions
  async function requestPermissions() {
    if (Platform.OS === 'android') {
      if (Platform.Version >= 31) {
        const result = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
        console.log('Permission result:', result);
      } else {
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        );
        console.log('Permission result (pre-Android 12):', result);
      }
    }
  }

  useEffect(() => {
    requestPermissions();

    const subscription = manager.onStateChange(state => {
      console.log('BLE state changed to:', state);
    }, true);

    return () => {
      manager.stopDeviceScan();
      subscription.remove();
      if (connectedDevice) {
        connectedDevice.cancelConnection().catch(() => {});
      }
      if (hrSubscription) hrSubscription.remove();
    };
  }, []);

  // Ensure Bluetooth is powered on
  const ensureBluetoothOn = async () => {
    const state = await manager.state();
    console.log('Bluetooth initial state:', state);
    if (state !== 'PoweredOn') {
      Alert.alert(
        'Bluetooth is Off',
        'Please turn on Bluetooth and try again.',
      );
      return false;
    }
    return true;
  };

  // Scan for nearby BLE devices
  const scanDevices = async () => {
    if (isScanning) return;
    const ready = await ensureBluetoothOn();
    if (!ready) return;

    setDevices([]);
    setIsScanning(true);
    setConnectedDevice(null);
    setDeviceInfo(null);
    setHeartRate(null);

    console.log('Starting BLE scan...');

    manager.startDeviceScan(
      null,
      { scanMode: ScanMode.LowLatency },
      (error, scannedDevice) => {
        if (error) {
          console.error('Scan error:', error.message);
          setIsScanning(false);
          return;
        }

        if (scannedDevice && scannedDevice.name) {
          setDevices(prev => {
            const exists = prev.some(d => d.id === scannedDevice.id);
            if (!exists) return [...prev, scannedDevice];
            console.log(prev, 'devices----');
            return prev;
          });
        }
      },
    );

    // Stop scanning after 5 seconds
    setTimeout(() => {
      console.log('Stopping BLE scan...');
      manager.stopDeviceScan();
      setIsScanning(false);
    }, 5000);
  };

  // Reset device list
  const resetList = () => {
    setDevices([]);
    setConnectedDevice(null);
    setDeviceInfo(null);
    setHeartRate(null);
  };

  // Connect to selected device
  const connectToDevice = async device => {
    try {
      if (isConnecting) return;
      setIsConnecting(true);

      console.log('Connecting to device:', device.name || device.id);
      manager.stopDeviceScan();

      const connected = await manager.connectToDevice(device.id);
      await connected.discoverAllServicesAndCharacteristics();

      console.log('Connected to device:', connected.name || connected.id);

      // Optional: Log all services/characteristics for debugging
      const services = await connected.services();
      for (const service of services) {
        console.log(`Service UUID: ${service.uuid}`);
        const characteristics = await service.characteristics();
        for (const char of characteristics) {
          console.log(`Characteristic UUID: ${char.uuid}`);
          console.log(`isReadable: ${char.isReadable}`);
          console.log(`isWritableWithResponse: ${char.isWritableWithResponse}`);
          console.log(`isNotifiable: ${char.isNotifiable}`);
        }
      }

      setConnectedDevice(connected);
      await readDeviceInfoAndBattery(connected);
      await subscribeToHeartRate(connected);

      Alert.alert(
        'Connected',
        `Connected to ${connected.name || connected.id}`,
      );
    } catch (error) {
      console.error('Connection error:', error.message);
      Alert.alert('Connection Failed', error.message);
    } finally {
      setIsConnecting(false);
      setIsScanning(false);
    }
  };

  // Disconnect from device
  const disconnectDevice = async () => {
    if (connectedDevice) {
      try {
        if (hrSubscription) hrSubscription.remove();
        await connectedDevice.cancelConnection();
        Alert.alert('Disconnected', 'Device disconnected successfully.');
      } catch (error) {
        console.error('Disconnection error:', error.message);
      } finally {
        setConnectedDevice(null);
        setDeviceInfo(null);
        setHeartRate(null);
      }
    }
  };

  // Read Device Information and Battery Level
  const readDeviceInfoAndBattery = async device => {
    try {
      const safeRead = async (service, char) => {
        try {
          const res = await device.readCharacteristicForService(service, char);
          return Buffer.from(res.value, 'base64').toString('utf-8');
        } catch {
          return 'N/A';
        }
      };

      const manufacturer = await safeRead(
        '0000180a-0000-1000-8000-00805f9b34fb',
        '00002a29-0000-1000-8000-00805f9b34fb',
      );

      // Battery Level
      let batteryLevel = 'N/A';
      try {
        const battery = await device.readCharacteristicForService(
          '0000180f-0000-1000-8000-00805f9b34fb',
          '00002a19-0000-1000-8000-00805f9b34fb',
        );
        batteryLevel = Buffer.from(battery.value, 'base64').readUInt8(0);
      } catch {
        batteryLevel = 'N/A';
      }

      console.log('Manufacturer:', manufacturer);
      console.log('Battery Level:', batteryLevel + '%');

      setDeviceInfo({
        manufacturer,
        battery: batteryLevel,
      });
    } catch (error) {
      console.error('Error reading device info or battery:', error.message);
    }
  };

  // Subscribe to Heart Rate Measurement (0x180D -> 0x2A37)
  const subscribeToHeartRate = async device => {
    try {
      console.log('Subscribing to heart rate notifications...');

      hrSubscription = device.monitorCharacteristicForService(
        '0000180d-0000-1000-8000-00805f9b34fb', // Heart Rate Service
        '00002a37-0000-1000-8000-00805f9b34fb', // Heart Rate Measurement
        (error, characteristic) => {
          if (error) {
            console.error('Heart rate monitor error:', error.message);
            return;
          }

          if (characteristic?.value) {
            const buffer = Buffer.from(characteristic.value, 'base64');
            // Standard BLE heart rate format: 1st byte = flags, 2nd byte = BPM
            const bpm = buffer.readUInt8(1);
            setHeartRate(bpm);
            console.log('0Heart Rate:', bpm, 'BPM');
          }
        },
      );
    } catch (e) {
      console.error('Failed to subscribe to heart rate:', e.message);
    }
  };

  const renderItem = ({ item }) => {
    const isConnected = connectedDevice && connectedDevice.id === item.id;
    return (
      <TouchableOpacity
        style={[
          styles.deviceItem,
          isConnected && { backgroundColor: '#E0F7FA' },
        ]}
        onPress={() => connectToDevice(item)}
        disabled={isConnecting || isConnected}
      >
        <Text style={styles.deviceName}>{item.name || 'Unknown Device'}</Text>
        <Text style={styles.deviceId}>{item.id}</Text>
        {isConnected && <Text style={styles.connectedText}>Connected</Text>}
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Nearby BLE Devices</Text>

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, { backgroundColor: '#4A90E2' }]}
          onPress={scanDevices}
          disabled={isScanning || isConnecting}
        >
          <Text style={styles.buttonText}>
            {isScanning ? 'Scanning…' : 'Scan Devices'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, { backgroundColor: '#E94E3C' }]}
          onPress={resetList}
          disabled={isScanning || isConnecting}
        >
          <Text style={styles.buttonText}>Reset List</Text>
        </TouchableOpacity>
      </View>

      {connectedDevice && (
        <TouchableOpacity
          style={[styles.disconnectButton, { backgroundColor: '#FF9800' }]}
          onPress={disconnectDevice}
        >
          <Text style={styles.buttonText}>Disconnect</Text>
        </TouchableOpacity>
      )}

      {isConnecting && (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#4A90E2" />
          <Text>Connecting...</Text>
        </View>
      )}

      <View style={styles.listWrapper}>
        <FlatList
          data={devices}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContainer}
        />
      </View>

      {deviceInfo && (
        <View style={styles.infoBox}>
          <Text style={styles.infoText}>
            Manufacturer: {deviceInfo.manufacturer}
          </Text>
          <Text style={styles.infoText}>Battery: {deviceInfo.battery}%</Text>
        </View>
      )}

      {heartRate !== null && (
        <View style={[styles.infoBox, { backgroundColor: '#FFF4E6' }]}>
          <Text style={[styles.infoText, { fontWeight: 'bold' }]}>
            Heart Rate: {heartRate} BPM
          </Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#fff' },
  title: { fontSize: 22, fontWeight: 'bold', marginBottom: 10 },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 15,
  },
  button: {
    flex: 1,
    padding: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginHorizontal: 5,
  },
  buttonText: { color: '#fff', fontSize: 16 },
  disconnectButton: {
    padding: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 15,
  },
  listContainer: { paddingBottom: 20 },
  deviceItem: {
    padding: 12,
    borderBottomWidth: 1,
    borderColor: '#ddd',
  },
  deviceName: { fontSize: 16, color: '#000' },
  deviceId: { fontSize: 12, color: '#555' },
  connectedText: { fontSize: 12, color: 'green', marginTop: 4 },
  loading: {
    alignItems: 'center',
    marginVertical: 10,
  },
  listWrapper: {
    height: 250,
    borderWidth: 1,
    padding: 10,
  },
  infoBox: {
    marginTop: 20,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#F0F8FF',
  },
  infoText: { fontSize: 16, color: '#333', marginBottom: 4 },
});

export default Home;
