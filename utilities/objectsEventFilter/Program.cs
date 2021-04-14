namespace ObjectEventFilter
{
    using System;
    using System.Runtime.Loader;
    using System.Text;
    using System.Threading;
    using System.Threading.Tasks;
    using Microsoft.Azure.Devices.Shared;
    using Microsoft.Azure.Devices.Client;
    using Microsoft.Azure.Devices.Client.Transport.Mqtt;
    using System.Linq;
    using Newtonsoft.Json;
    using Newtonsoft.Json.Linq;
    using System.Collections.Generic;

    class Program
    {
        static string objectTagValue = "";
        static string objectTypeValue = "";
        static string objectTagName = "";
        static string objectTypeName = "";
        static double objectConfidence = 0;

        static void Main(string[] args)
        {
            Init().Wait();

            // Wait until the app unloads or is cancelled
            var cts = new CancellationTokenSource();
            AssemblyLoadContext.Default.Unloading += (ctx) => cts.Cancel();
            Console.CancelKeyPress += (sender, cpe) => cts.Cancel();
            WhenCancelled(cts.Token).Wait();
        }

        /// <summary>
        /// Handles cleanup operations when app is cancelled or unloads
        /// </summary>
        public static Task WhenCancelled(CancellationToken cancellationToken)
        {
            var tcs = new TaskCompletionSource<bool>();
            cancellationToken.Register(s => ((TaskCompletionSource<bool>)s).SetResult(true), tcs);
            return tcs.Task;
        }

        /// <summary>
        /// Initializes the ModuleClient and sets up the callback to receive
        /// messages containing temperature information
        /// </summary>
        static async Task Init()
        {
            MqttTransportSettings mqttSetting = new MqttTransportSettings(TransportType.Mqtt_Tcp_Only);
            ITransportSettings[] settings = { mqttSetting };

            // Open a connection to the Edge runtime
            ModuleClient ioTHubModuleClient = await ModuleClient.CreateFromEnvironmentAsync(settings);
            await ioTHubModuleClient.OpenAsync();
            Console.WriteLine("IoT Hub module client initialized.");

            // Register callback to be called when a message is received by the module
            await ioTHubModuleClient.SetInputMessageHandlerAsync("detectedObjects", SendEventByFilter, ioTHubModuleClient);

            // Register callback to be called when desired property changes
            await ioTHubModuleClient.SetDesiredPropertyUpdateCallbackAsync(OnDesiredPropertyChanged, ioTHubModuleClient);

            Twin moduleTwin = ioTHubModuleClient.GetTwinAsync().GetAwaiter().GetResult();
            ReadDesiredProperties(moduleTwin.Properties.Desired);
        }
        
        /// <summary>
        /// Reads the IoT Module settings from the deployment and sets them in the objectsEventFilter runtime
        /// </summary>
        private static void ReadDesiredProperties(TwinCollection desiredProperties)
        {
            if (desiredProperties.Contains("objectTagValue"))
            {
                objectTagValue = desiredProperties["objectTagValue"];
            }

            if (desiredProperties.Contains("objectTypeValue"))
            {
                objectTypeValue = desiredProperties["objectTypeValue"];
            }

            if (desiredProperties.Contains("objectTagName"))
            {
                objectTagName = desiredProperties["objectTagName"];
            }

            if (desiredProperties.Contains("objectTypeName"))
            {
                objectTypeName = desiredProperties["objectTypeName"];
            }

            if (desiredProperties.Contains("objectConfidence"))
            {
                objectConfidence = desiredProperties["objectConfidence"];            
            }

            Console.WriteLine($"objectTag set to {objectTagValue}");
            Console.WriteLine($"objectType set to {objectTypeValue}");            
            Console.WriteLine($"objectConfidence set to {objectConfidence}");            
        }

        /// <summary>
        /// Updates the desired properties on change during runtime.
        /// </summary>
        private static async Task OnDesiredPropertyChanged(TwinCollection desiredProperties, object userContext)
        {                        
            try
            {     
                ReadDesiredProperties(desiredProperties);

                ModuleClient ioTHubModuleClient = (ModuleClient)userContext;
                
                TwinCollection reportedProperties = new TwinCollection();
                reportedProperties["DateTimeLastDesiredPropertyChangeReceived"] = DateTime.Now;

                await ioTHubModuleClient.UpdateReportedPropertiesAsync(reportedProperties).ConfigureAwait(false);
            }
            catch(Exception ex)
            {
                Console.WriteLine("Exception in OnDesiredPropertyChanged");
                Console.WriteLine(ex);
            }
        }    


        /// <summary>
        /// This method is called whenever the module is sent a message from the EdgeHub.         
        /// </summary>
        static async Task<MessageResponse> SendEventByFilter(Message message, object userContext)
        {            
            var moduleClient = userContext as ModuleClient;
            if (moduleClient == null)
            {
                throw new InvalidOperationException("UserContext doesn't contain " + "expected values");
            }

            byte[] messageBytes = message.GetBytes();
            string messageString = Encoding.UTF8.GetString(messageBytes);

            if (!string.IsNullOrEmpty(messageString))
            {
                var inferences = JObject.Parse(messageString);

                var typeItem = inferences.SelectTokens("$..entity");
                var found = false;
                var confidenceValue = 0.0d;
                foreach (var item in typeItem)
                {
                    var hasColor = item.SelectToken("attributes").Any(x => (x.SelectToken("name").ToString() == objectTagName && x.SelectToken("value").ToString() == objectTagValue));
                    var hasType = item.SelectToken("attributes").Any(x => (x.SelectToken("name").ToString() == objectTypeName && x.SelectToken("value").ToString() == objectTypeValue));
                    confidenceValue = (double)item.SelectToken("tag.confidence");
                    var hasConfidence = confidenceValue >= objectConfidence;

                    if(hasColor && hasType && hasConfidence)
                    {
                        found = true;
                        break;
                    }
                }

                if (found)
                {
                    var result = new Dictionary<string, object> {
                        { "confidence", confidenceValue },
                        { objectTagName, objectTagValue },
                        { objectTypeName, objectTypeValue }
                    };

                    string outputMsgString = JsonConvert.SerializeObject(result);
                    byte[] outputMsgBytes = System.Text.Encoding.UTF8.GetBytes(outputMsgString);
                    using (var outputMessage = new Message(outputMsgBytes))
                    {
                        string subject = message.Properties["subject"];
                        string graphInstanceSignature = "/graphInstances/";
                        if (subject.IndexOf(graphInstanceSignature) == 0)
                        {
                            int graphInstanceNameIndex = graphInstanceSignature.Length;
                            int graphInstanceNameEndIndex = subject.IndexOf("/", graphInstanceNameIndex);
                            string graphInstanceName = subject.Substring(0, graphInstanceNameEndIndex);
                            outputMessage.Properties.Add("eventTime", message.Properties["eventTime"]);
                            await moduleClient.SendEventAsync("objectsEventFilterTrigger", outputMessage);
                        }
                    }
                }
            }
            return MessageResponse.Completed;
        }
    }
}
