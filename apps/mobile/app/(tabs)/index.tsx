import { StyleSheet, View, Text } from 'react-native';

export default function ShiftsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Shifts</Text>
      <Text style={styles.subtitle}>This screen will show your assigned shifts.</Text>
      <Text style={styles.placeholder}>(Functionality not implemented yet)</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 20,
    color: '#666',
  },
  placeholder: {
    fontSize: 14,
    color: '#999',
    fontStyle: 'italic',
  },
});
