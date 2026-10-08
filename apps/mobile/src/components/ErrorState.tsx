import { StyleSheet, View, Text } from 'react-native';

interface ErrorStateProps {
  message?: string;
}

export const ErrorState = ({ message = 'An error occurred' }: ErrorStateProps) => {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Oops!</Text>
      <Text style={styles.text}>{message}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 10,
    color: '#d32f2f',
  },
  text: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
  }
});
