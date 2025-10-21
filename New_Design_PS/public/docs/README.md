**One Identity open source projects are supported through [One Identity GitHub issues](https://github.com/OneIdentity/IdentityManager.PoSh-Connector-Guide/issues) and the [One Identity Community](https://www.oneidentity.com/community/). This includes all scripts, plugins, SDKs, modules, code snippets or other solutions. For assistance with any One Identity GitHub project, please raise a new Issue on the [One Identity GitHub project](https://github.com/OneIdentity/IdentityManager.PoSh-Connector-Guide/issues) page. You may also visit the [One Identity Community](https://www.oneidentity.com/community/) to ask questions. Requests for assistance made through official One Identity Support will be referred back to GitHub and the One Identity Community forums where those requests can benefit all users.**

# PowerShell Connector Guide
An in-depth guide to the PowerShell connector of Identity Manager.

# Table of Contents
- [PowerShell Connector](#powershell-connector)
  - [Some PowerShell basics](#some-powershell-basics)
    - [PowerShell hosts](#powershell-hosts)
    - [Runspaces](#runspaces)
    - [Command(let)s](#commandlets)
    - [Pipeline](#pipeline)
    - [Output](#output)
  - [Some Synchronization framework basics](#some-synchronization-framework-basics)
    - [Connections](#connections)
    - [Target system schema](#target-system-schema)
    - [Query data](#query-data)
    - [Modify data](#modify-data)
  - [The PowerShell connector XML definition format](#the-powershell-connector-xml-definition-format)
    - [The ConnectorDefinition element](#the-connectordefinition-element)
    - [The PluginAssemblies element](#the-pluginassemblies-element)
    - [The ConnectionParameters element](#the-connectionparameters-element)
    - [The Initialization element](#the-initialization-element)
      - [CustomCommands](#customcommands)
      - [PredefinedCommands](#predefinedcommands)
      - [EnvironmentInitialization](#environmentinitialization)
    - [The Schema element](#the-schema-element)
      - [The Class element](#the-class-element)
        - [The Properties element](#the-properties-element)
          - [The ReturnBindings element](#the-returnbindings-element)
          - [Path bindings](#path-bindings)
          - [The CommandMappings element](#the-commandmappings-element)
          - [The ReferenceTargets element](#the-referencetargets-element)
          - [The ModifiedBy element](#the-modifiedby-element)
        - [The ReadConfiguration element](#the-readconfiguration-element)
        - [The MethodConfiguration element](#the-methodconfiguration-element)
  - [Common concepts/deep dive](#common-conceptsdeep-dive)
    - [Command sequences](#command-sequences)
      - [Command sequence item](#command-sequence-item)
      - [SetParameter elements](#setparameter-elements)
    - [Custom commandlet to deal with multi-valued references (member properties)](#custom-commandlet-to-deal-with-multi-valued-references-member-properties)
      - [Replace modification](#replace-modification)
      - [Add/Remove modification (Modify)](#addremove-modification-modify)
  - [Best practices](#best-practices)
    - [Logging](#logging)
    - [Use SecureStrings](#use-securestrings)
    - [Script modules vs. Custom commandlets](#script-modules-vs-custom-commandlets)
    - [Global variables (... and caching)](#global-variables--and-caching)
  - [Sample connector](#sample-connector)
    - [Prerequisites:](#prerequisites)
    - [XML definition](#xml-definition)
- [License](#license)

# PowerShell Connector

The PowerShell connector was originally developed as an abstract base layer for the Exchange connector. The goal was to develop a configurable middleware that "translates" the parameters and outputs of PowerShell calls to/from the requirements of the One Identity manager connector interface while hiding most of its complexity. Originally planned not to be published as a standalone connector, the documentation of how to properly do things in the PowerShell connector is an area that can be improved. This document is meant to be a deep(er) dive than the adsample.xml that is currently shipped with the connector.

## Some PowerShell Basics

Before we can explore the internals of the middleware, we must first understand some of the basic concepts of PowerShell. Especially when running in-process and not in a console host.

### PowerShell Hosts
When thinking of "PowerShell", people usually have a console window in mind. In reality, the console window is "just" an application that uses PowerShell. Such an application creates a runspace for running pipelines with one or more commands (commandlets) (this is described in more detail later) and interacting with the application via a host. The PowerShell "Host" is the part of the hosting application that provides I/O capabilities.

### Runspaces
A runspace is the PowerShell runtime environment. It knows about global variables, loaded commandlets etc. A runspace can exist locally or you can create runspaces on remote machines using PowerShell Remoting. The PowerShell connector always uses a local runspace but it an also connect to remote machines in other ways, like importing remote sessions to your local runspace.

### Command(let)s
Commandlets are functions that are known within your runspace. Besides the default functions that are available in PowerShell you can load other ones by importing PowerShell modules. These are collections of commandlets designated for a specific purpose. It is also possible to create temporary "custom" commandlets within your runspace. Each commandlet can take a defined set of parameters and output the return values to the pipeline. In addition to returning values to the pipeline, it can interact with the host UI i.e., writing status messages, warnings, or requesting user interaction if supported by the host of the runspace. Note that such status messages are not known to the pipeline or the runspace. For more information, see the ["Output"](#output) section. A commandlet can have multiple parameter sets which are groups of parameters for different use cases.

### Pipeline
Image a pipeline as a chain of commandlets that are run in sequence. The elements of the chain are separated by pipe operators ('|'). The output of one command is sent to the following command in the chain as its input parameter. The following command must know what to do with the type of output the previous command sends it. Even if you just run a single command, PowerShell creates a pipeline internally.

Sample code:
 ```shell
    Get-Process | Format-Table Id,Name
 ```
The output of Get-Process is a list "Process" instances. That list is piped to the Format-Table commandlet. To be more precise to its "InputObject" parameter. The "Id,Name" values are assigned to the "Property" parameter. This is a positional parameter which means without specifying the parameter name, the commandlet knows where to assign it. Instead of implicitly piping the output of Get-Process, you could also assign the output to a variable and call Format-Table with explicit parameter afterwards.
 ```shell
    $processes = Get-Process
    Format-Table -InputObject $processes -Property Id,Name
 ```
### Output
The regular command prompt does not differentiate between between informative messages that are printed out by the command line application you call and other output. This can make it a little bit tricky to process the output afterwards. As stated in the previous sections, PowerShell can distinguish between "UI" messages (streams) and actual data (output stream). Lets take a look at the following call
 ```shell

    > {Write-Host "Get PowerShell and explorer process"; Get-Process PowerShell; Get-Process explorer}.Invoke()
 ```
This runs the script block { Command1; Command2; ... }.Invoke(). It writes a message to the host and then tries to find the processes of "explorer" and afterwards "PowerShell". 
The output of the console window will look something like this:

Get PowerShell and explorer process

    Handles  NPM(K)    PM(K)      WS(K)     CPU(s)     Id  SI ProcessName
    -------  ------    -----      -----     ------     --  -- -----------
       1445      91   234200     181640     112.09  27012   1 PowerShell
       5400     173   281864     224296   6,767.22  16100   1 explorer

Now let us capture the actual output (without any messages) to a variable and see what happens
 ```shell
    > $output = {Write-Host "Get PowerShell and explorer process"; Get-Process PowerShell; Get-Process explorer}.Invoke()
 ```
The console output now looks like this:

    Get PowerShell and explorer process

The $output variable, however, now contains 2 process objects. You can use the $output variable to print the 2 process instances to the console window again. Since those are not only strings but actual objects, you can also reformat them with built-in PowerShell functions like Format-List. 
 ```shell
    > $output | Format-List Id,ProcessName,Handles
    
    Id          : 27012
    ProcessName : PowerShell
    Handles     : 1453
    
    Id          : 16100
    ProcessName : explorer
    Handles     : 5409
 ```
When it comes to custom commandlets that return values, make sure you do not accidentally write "debug" messages to the output stream. This happens every time you type a variable name or use the Write-Output commandlet.

The following examples show "accidents" that can also mess up your connector implementations because the PowerShell connector uses everything that was written to output.

**Example 1: The unwanted output.** 
 ```shell
    function Get-ExplorerProcessWithLog
    {
        "Trying to get explorer process" #this puts the string on the output, use Write-Host ".." instead
        $ep = Get-Process explorer
        $ep
    }
    $output = Get-ExplorerProcessWithLog
 ```
The output variable will now contain 2 objects, a string and the contents explorer process instance.

**Example 2: Write-Output instead of Write-Host/Write-Warning etc..** 
 ```shell
    function Get-ExplorerProcessWithLog
    {
        Write-Output "Trying to get explorer process" #Write-Output puts the string on the output, use Write-Host ".." instead
        $ep = Get-Process explorer
        $ep
    }
    $output = Get-ExplorerProcessWithLog
 ```
The output variable will now (again) contain 2 objects, a string and the contents explorer process instance.

**Example 3: Unwanted commandlet call instead of Write-Host/Write-Warning etc..** 
 ```shell
    function Get-ExplorerProcessWithLog
    {
        Get-Location #Gets the current path the script is running from and puts it to the output stream. To prevent this you can pipe to write-Host by Get-Location | Write-Host
        $ep = Get-Process explorer
        $ep
    }
    $output = Get-ExplorerProcessWithLog
 ```
The output variable will now (again) contain 2 objects, a PathInfo instance and the contents explorer process instance.

To conclude - when writing custom commandlets, make sure you only write things to the output stream that you want the connector to handle.

## Some synchronization framework basics

The Identity Manager synchronization engine relies on a complex connector interface. The PowerShell connector "hides" some of this complexity but there is need for some understanding of the basic concepts mentioned in the following sections.

### Connections
In order to connect a target system, the connection parameter data must be available. The synchronization engine initiates a connection by sending a *Connect* call to the connector. As a parameter, this call has a connection string parameter that is similar to connection strings known from SQL server connections. When the synchronization engine does not requires a connection anymore, it calls a disconnect method to free up resources.

### Target system schema
To create a synchronization project, the connector needs to provide very detailed information about the schema of the target system. This contains the type of objects that exist in the system and their properties. Relations between the schema types, like memberships, are also part of a schema definition. The last part that is provided for each schema type is a method that can be called, such as insert/update/delete.

### Query data
The term "synchronization" in Identity Manager context usually means reading data from the target system and storing it in the identity manager database. Queries are always limited to the elements of objects with a particular type but can be limited to a subset of objects and or a subset of requests properties of those objects. In a synchronization scenario, normally two types of queries are used.

1. Query a list of all system objects with a reduced set of properties. These properties contain unique keys that identify an object instance as well as properties that are used to find the corresponding records in the Identity Manager database during the matching phase. The matching phase finds object pairs or sub/super sets between the Identity Manager database and the target system.
2. Query individual system objects with a broader or full set of properties. The result of the query is used during the mapping phase where the value of the properties is compared and synchronized between the Identity manager database and the target system.

### Modify data
Besides queries, a connector can perform other actions (methods) on/with system objects. The set of available methods is also defined in the schema for each type of system object. The most common methods are Insert, Update, Delete but a connector can support other custom methods.

For modifications at property level, the synchronization engine uses different modes similar to the LDAP protocol. It can *replace* or *modify* values. *Modify* is only possible for multi-valued attributes and might consist of *Add* and *Remove* operations for individual attribute values. A common example is adding/removing users to a group vs. replacing the complete list of members at once.

For a deeper dive into the synchronization concepts, have a look at [this document](https://github.com/OneIdentity/IdentityManager.PoSh-Connector-Guide/blob/main/One%20Identity%20Manager%208.0%20Synchronization%20Technology.pdf)

## The PowerShell connector XML definition format

The PowerShell XML definition format acts as a translation layer between the Identity Manager connector components described before and the data flow in a PowerShell session. It can also add custom commands to the PowerShell session, which is often required to make the PowerShell "world" compatible with the requirements of the Identity Manager connector interface. A common use case for custom commandlets is to support the different modes of attribute modifications used by the synchronization engine (*replace vs. modify*).

The following sections contain a detailed description of a PowerShell definition structure. The examples shown in the individual element descriptions are just for syntax purposes. For a real working example check out the [Sample connector](#sample-connector) section.

### The ConnectorDefinition element
This root element provides some basic information about the contents of the definition such as an ID, a version, and a description. The element supports the following attributes:

|Attribute|Mandatory|Description|
|--|--|--|
|Id|Yes|Short identifier of the target system.|
|Version|Yes|The current version of this definition.|
|Description|Yes|More detailed information about the definition.|

**Sample code**

 ```xml
<?xml version="1.0" encoding="utf-8" ?>
<PowershellConnectorDefinition Id="MGraph" Version="1.0" Description="Basic Microsoft Graph connector">
    ...
</PowershellConnectorDefinition>
```

The *PowershellConnectorDefinition* element has the following four sub elements:
- [PluginAssemblies](#the-pluginassemblies-element)
- [ConnectionParameters](#the-connectionparameters-element)
- [Initialization](#the-initialization-element)
- [Schema](#the-schema-element)

### The PluginAssemblies element
The *PluginAssemblies* element can contain *Assembly* elements that add a reference to a *.dll file with extensions to the base PowerShell connector. Those extensions are usually specific conversion methods to either convert the output of a command to a synchronization engine compatible representation or convert a value sent by the synchronization engine to a commandlet parameter. 

Both cases can usually be implemented by using custom commandlets. **You should only use plugins, if there is no way to handle the use case with a custom commandlet.**

An *Assembly* element contains the path to the dll to load relative to the Identity Manager installation directory

|Attribute|Mandatory|Description|
|--|--|--|
|Path|Yes|Relative path to the *.dll to load.|

**Sample code**

 ```xml
<PluginAssemblies>
    <Assembly Path="myExtensions.dll"/>
</PluginAssemblies>
```

### The ConnectionParameters element
The *ConnectionParameters* element contains the **definitions** of the parameters used to connect to the target system. The connection wizard of the PowerShell connector uses this information to render a generic UI that creates a suitable connection string to create the [connection](#connections). Each connection parameter is represented by a *connectionparameter* element.

|Attribute|Mandatory|Description|
|--|--|--|
|Name|Yes|The name of the parameter.|
|Description|No|The description of the parameter.|
|IsSensibleData|No|'**true**' if the parameter contains a secret value like a password, otherwise '**false**' (default if omitted). If '**true**', the generic UI masks inputs like a password input box|

**Sample code**

 ```xml
<ConnectionParameters>
    <ConnectionParameter Name="Username" Description="Username for the Graph connection" />
    <ConnectionParameter Name="Password" IsSensibleData="true" />
</ConnectionParameters>
```

### The Initialization element
The initialization element contains everything required for setting up the PowerShell runtime environment. You can implement [custom commandlets](#customcommands) and configure which commands need to be run in order to [connect or disconnect](#environmentinitialization). 

In addition to this, [a list of directly used (non custom) commandlets](#predefinedcommands) must be provided. While this is not actually required to build the runtime environment, it enables the consistency checks to identify typos in the rest of the connector definition.

**Sample code**

 ```xml
<Initialization>
    <!--custom commands injected in the session (user defined PowerShell functions)-->
    <CustomCommands>
        ...
    </CustomCommands>
    <!--list of directly used commandlets-->
    <PredefinedCommands>
        ...
    </PredefinedCommands>
    <!--connect/disconnect-->
    <EnvironmentInitialization>
        ...
    </EnvironmentInitialization>
    
</Initialization>
```
#### CustomCommands
Custom commands are PowerShell functions that are made available for the lifetime of the PowerShell session. The connector creates such a session and injects the functions right at the beginning before it even tries to connect. A custom command has a name and the implementation of the function body enclosed in a CDATA element. Although not enforced, it is recommended to add a prefix to your commandlet and follow basic naming conventions. 

**Suggestion**

```
<Verb>-<Prefix><Noun>
```
**Sample code**

Using Prefix *OneIM*
 ```
Connect-OneIMGraphInstance
Set-OneIMGraphUser
```
|Attribute|Mandatory|Description|
|--|--|--|
|Name|Yes|The name of the custom commandlet.|

**Sample code**
 ```xml
<CustomCommands>
    <CustomCommand Name="Connect-OneIMExchangeOnline">
    <![CDATA[
        param(
            [String]$Username,
            [SecureString]$Password
        )
        $cred = New-Object System.Management.Automation.PsCredential -ArgumentList $Username,$Password
        Connect-ExchangeOnline -Credential $cred
    ]]>
    </CustomCommand>            
</CustomCommands>
```

#### PredefinedCommands
This element contains the list of every commandlet that is called directly. You do not need to list commands called from within custom commandlets here. The consistency check in the connection wizard uses the command name list plus the list of custom command names to validate the rest of the xml definition.

|Attribute|Mandatory|Description|
|--|--|--|
|Name|Yes|The name of the used commandlet.|

**Sample code**

 ```xml
<PredefinedCommands>
    <Command Name="Disconnect-ExchangeOnline" />
    ...
</PredefinedCommands>
```

#### EnvironmentInitialization
The *EnvironmentInitialization* element contains the [command sequences](#command-sequences) that are used to connect to/disconnect from the target system. The *Connect* and *Disconnect* commands are run when synchronization instructs the PowerShell connector to connect/disconnect. In the connect sequence, you can load external PowerShell modules and establish a connection to the external system and test it. In the disconnect sequence, free up resources and disconnect any existing internal connections.

**Sample code**

 ```xml
<EnvironmentInitialization>
    <Connect>
        <CommandSequence>
            <Item Command="Connect-OneIMExchangeOnline" Order="1">
                <SetParameter Param="Username" Source="ConnectionParameter" Value="Username" />
                <SetParameter Param="Password" Source="ConnectionParameter" Value="Password" ConversionMethod="ToSecureString"/>
            </Item>
        </CommandSequence>
    </Connect>
    <Disconnect>
        <CommandSequence>
            <Item Command="Disconnect-ExchangeOnline" Order="1"/>
        </CommandSequence>
    </Disconnect>
</EnvironmentInitialization>
```

### The Schema element
The schema defines the types, their properties and methods that are supplied to the synchronization engine. It contains 1 to n *class* elements.

#### The Class element
Each *class* element is a schema type in connector terminology. It provides information on how to translate command input/output to/from objects in the synchronization framework. There are three core elements of a class definition:

- The **Properties** element (Property definitions)
- The **ReadConfiguration** element (How to obtain data)
- The optional **MethodConfiguration** element (Methods such as insert/update/delete ...)

A class element has the following attributes:
|Attribute|Mandatory|Description|
|--|--|--|
|Name|Yes|The name class (schematype).|
|Description|No|A description of the class.|
|IsObsolete|No|If set to **'true'** the synchronization engine displays the schema type as obsolete. That can be useful if you plan to release a newer version of the connector definition that no longer supports this class.|

**Sample code** (basic structure)

 ```xml
<Schema>
    <Class Name="User" Description="User and its profile data">
        <Properties>
            ...
        </Properties>
        <ReadConfiguration>
            ...
        </ReadConfiguration>
        <MethodConfiguration>
            ...            
        </MethodConfiguration>
    </Class>
    <Class Name="UserProfile" Description="Obsolete since UserProfile properties were merged with the user class" IsObsolete="true">
        <Properties>
            ...            
        </Properties>
        <ReadConfiguration>
            ...            
        </ReadConfiguration>
        <!--No methods, profiles are read only-->        
    </Class>
    <Class Name="Group" Description="Groups in the target system">
        <Properties>
            ...            
        </Properties>
        <ReadConfiguration>
            ...            
        </ReadConfiguration>
        <MethodConfiguration>
            ...            
        </MethodConfiguration>
    </Class>
</Schema>
```

##### The Properties element
The **Properties** element contains a detailed definition of the properties available for a class, how to read them, and pass them to PowerShell commands. It has the following attributes:

|Attribute|Mandatory|Description|
|--|--|--|
|Name|Yes|The name of the property.|
|Description|No|A description of the property.|
|DataType|Yes|The data type of the property. This can be **String**, **Bool**, **Int**, **DateTime**.|
|IsDisplay|No|If set to **'true'** this property is used as display value for the schema type.<br/> &#9888; Each class must have one property that is marked with this flag. <br/> &#9888; The property marked as Display will always be loaded when querying data from the target system.|
|IsMandatory|No|If set to **'true'** this property is marked as mandatory property.|
|IsUniqueKey|No|If set to **'true'** this property is marked as the unique key for instances of this class.<br/> &#9888; Each class must at least have one property marked as unique key.|
|IsMultiValue|No|If set to **'true'** this property is multi-valued and can contain a list of values of the type specified in the **DataType** attribute.|
|IsRevision|No|If set to **'true'** this property is used as a revision for synchronization optimization. You can mark multiple properties as revision but they must be of the same datatype. The value must also be a comparable value that increases when the object is updated. When multiple properties are marked, the connector will use the maximum value of all properties. Marking at least one property will automatically enable revision handling for the containing schema type.|
|IsSecret|No|If set to **'true'** this property is marked as secret value. This will prevent it from being shown in logs etc.|
|AccessConstraint|No|Specifies how the property can be accessed. Possible values are <br/> **None**: (default, if a [ModifiedBy](#the-modifiedby-element) is present) read/write<br/>.**ReadOnly** (default, if no [ModifiedBy](#the-modifiedby-element) is present): read.<br/>**ReadAndInsertOnly**: property can only be written during object creation (insert). Afterwards it is read-only<br/>**WriteOnly**: property can only be written but never read (passwords for example).|
|IsAutofill|No|If set to **'true'** this indicates that the target system will automatically generate a value for this property (object IDs/GUIDs for example).|
|IsObsolete|No|If set to **'true'** the synchronization engine will display the property as obsolete. That can be useful if you plan to release a newer version of the connector definition that no longer supports this property.|
|IsObsolete|No|Only applies to properties that are marked as *isMultivalue*; If set to **'true'** the synchronization engine will take the order of the elements in to account when comparing values (for example when comparing the property value with the corresponding database record).|

**Sample code**

 ```xml
<Property Name="Identity" DataType="String" AccessConstraint="ReadOnly" IsMandatory="true" IsUniqueKey="true" >
    ...
</Property>

<Property Name="DisplayName" DataType="String" IsDisplay="true" >
    ...
</Property>

<Property Name="ExternalDirectoryObjectId" DataType="String" IsUniqueKey="true" >
    ...
</Property>

<Property Name="WhenChangedUTC" DataType="DateTime" IsRevision="true">
    ...
</Property>

<Property Name="EmailAddresses" DataType="String" IsMultivalue="true" >
    ...
</Property>
```

###### The ReturnBindings element
This contains 1 to n *Bind* elements that specify which commandlet returns the value for that property and how to obtain it. A property can be returned by multiple commands depending on the operational context (runs query/method etc.).

A *Bind* element consists of the following attributes:
|Attribute|Mandatory|Description|
|--|--|--|
|CommandResultOf|Yes|The name of the command that returns the value for the property. This must either be a [CustomCommand](#customcommands) or a [PredefinedCommand](#predefinedcommands).|
|Path|Yes|The command specified in *CommandResultOf* is expected to return a PSObject instance with properties. The Path specifies which of those properties should be used to read the value. More information about the path attribute can be found [here](#path-bindings)|
|Converter|No|After retrieving the value specified in the *Path* attribute, a converter can be attached to convert the value to one of the basic supported data types. The following converters are available out of the box. Custom converters can be added using [plugin assemblies](#the-pluginassemblies-element) but it is recommended to perform the conversion in a [custom commandlet](#customcommands) instead. <br/><br/>**SizeStringToBytes**: (from Exchange) extracts the bytes portion of string like *"1 MB (1000000 bytes)"* and returns it as long. If the string is *"unlimited"*, -1 is returned<br/><br/>**TimespanStringToInt**: (from Exchange) converts a timespan string representation to the number of ticks. If the string is *"unlimited"*, 0 is returned<br/><br/>**TrueIfNotNull**: returns boolean *true*, if the value is not null<br/>**UnlimitedTypeToInt**: converts the string representation of an integer to long, if the string is *"unlimited"*, -1 is returned<br/><br/>**UtcDateTimeStringNormalizer**:converts a DateTime instance to its string representation. It is recommended to only use this converter in compatibility scenarios, where the DateTime value was returned as a string in the past and now is returned as DateTime instance.|

**Sample code** (multiple bindings)

 ```xml
<ReturnBindings>
    <Bind CommandResultOf="Get-OneIMGrapUser" Path="Id"/>
    <Bind CommandResultOf="New-OneIMGraphUser" Path="Id"/>
</ReturnBindings>
```

**Sample code** (converter)

 ```xml
<ReturnBindings>
    <Bind CommandResultOf="Get-EXOMailboxstatistics" Path="TotalItemSize" Converter="SizeStringToBytes"/>
</ReturnBindings>
```

###### Path bindings
Path bindings are used in [ReturnBindings](#the-returnbindings-element) elements to specify the source of a property value relative to the returned object. Let us look at the output of the following call:
 
 ```shell
C:\Users\demo> $rootPath = Get-Item C:\
C:\Users\demo> $rootPath

    Directory:


Mode                 LastWriteTime         Length Name
----                 -------------         ------ ----
d--hs-         6/18/2024  11:58 PM                C:\
 ```

If we want to create a returnbinding that returns the Name, we need to get following property. 

 ```shell
$rootPath.Name
 ```
The *Name" is the path relative to the $rootPath object that contains our value. So the return binding would be:
 ```xml
<ReturnBindings>
    <Bind CommandResultOf="Get-Item" Path="Name"/>
</ReturnBindings>
```

Assuming we want to get the year, we can first check the type of LastWriteTime from LastWriteTime.
 ```shell
C:\Users\demo> $rootPath.LastWriteTime.GetType()

IsPublic IsSerial Name                                     BaseType
-------- -------- ----                                     --------
True     True     DateTime                                 System.ValueType
 ```
We can see that LastWriteTime is a System.DateTime. This class has a "Year" property that we can access. Our Returnbinding would look like this:

 ```xml
<ReturnBindings>
    <Bind CommandResultOf="Get-Item" Path="LastWriteTime.Year"/>
</ReturnBindings>
```
You can traverse the instances over multiple levels. 

The ".ToString()" suffix ensures that the returned value is converted to a string. The FileAttributes property of our object is of type System.Enum for example. To get the string representation, we can add ".ToString()" to the path as follows: 

 ```xml
<ReturnBindings>
    <Bind CommandResultOf="Get-Item" Path="FileAttributes.ToString()"/>
</ReturnBindings>
```

If arrays or dictionaries are returned, you can use index notation to access a specific item rather than the whole array/dictionary, as follows:

 ```xml
<ReturnBindings>
    <!--return 5th element of array property "Userlist"-->
    <Bind CommandResultOf="Get-Something" Path="Userlist[5]"/>
</ReturnBindings>

<ReturnBindings>
    <!--return element 'homeDir' of dictionary property "UserParameters"-->
    <Bind CommandResultOf="Get-Something" Path="UserParameters['homeDir']"/>
</ReturnBindings>

```
###### The CommandMappings element
To configure value mappings of a connector object to commands, the *CommandMappings* element contains 1 to n *Map* elements. There are typically three scenarios where you want to map a connector object value to a command:
1. The value is required by the command to identify an existing target system object to perform further operations like update or delete.
2. The connector object value has changed and needs to be transferred to the target system. This is usually done by calling a modifying commandlet. To specify the commands that actually modify the target system object value, use [ModBy](#the-modby-element) elements.
3. The connector object is new (not present in the target system yet) and needs to be provisioned to the target system.

**Sample code**

In this example, the value of the **Name** property is used for different purposes. The Name [property](#the-properties-element) *IsUniqueKey* attribute is set to true.
 ```xml
<CommandMappings>
    <!--The Name parameter of Set-User is used to identify the target system object that should be modified,
    Therefore, the old value needs to be used to populate the parameter value
    -->
    <Map ToCommand="Set-User" Parameter="Name" UseOldValue="true" />
     <!--The NewName parameter of Set-User is used to rename the target system object. The mapping is only executed,
     if the engine sent a modification for the Name property
    -->   
    <Map ToCommand="Set-User" Parameter="NewName" />
    <!--Specify the Name parameter for a new user when calling the New-User commandlet-->
    <Map ToCommand="New-User" Parameter="Name" />
    <!--Specify the Name Parameter to identify the user to be loaded by the Get-User commandlet -->
    <Map ToCommand="Get-User" Parameter="Name" />
    <!--Specify the UserName Parameter to with the name of the user that needs to be checked for -->
    <Map ToCommand="Test-OneIMUserExists" Parameter="UserName" />
</CommandMappings>
```

In either case, you need to define which parameter of which command to pass the connector object to.
A *Map* element consists of the following attributes:

|Attribute|Mandatory|Description|
|--|--|--|
|ToCommand|Yes|The name of the [custom command](#customcommands) or [predefined command](#predefinedcommands) to receive the attribute value.|
|Parameter|No|The name of the parameter to pass the value to. <br/>**Note:** This can be empty if a converter is used.|
|UseOldValue|No|If the connector object value was changed (during a modification e.g. update) you can set *UseOldValue* to *true* to pass the original value of the property to the command|
|Converter|No|A parameter converter can perform advanced parameter mapping operations like setting multiple command parameters at once or performing data conversions. The following table contains a list of available converters and their requirements.|
|ModType|No|Specifies that the mapping is run only if the connector object property modification is of a certain type. Permitted values are: <br/>**Replace** only replace modifications are allowed to use this mapping<br/>**Add** only add modifications are allowed to use this mapping<br/>**Remove** only remove modifications are allowed to use this mapping. This setting is used in very rare edge cases only.|

**List of converters**
The following converters are available out of the box. Most of them are used in Exchange Online and Exchange on-prem connectors. Those will not be explained in detail. If the converter requires a parameter name in the *Bind* element, it is noted in the corresponding column (Req. Param. Attr.)
|Converter|Req. Param. Attr.|Description|
|--|--|--|
|BytesToUnlimitedType|Yes|*Exchange specific - internal use only*|
|CountryFriendlyName|Yes|*Exchange specific - internal use only*|
|CustomMvp|No|Special converter for dealing with member properties. See [Custom MVP reference commandlet](#custom-commandlet-to-deal-with-multi-valued-references-member-properties)|
|ExchangeMvpString|Yes|*Exchange specific - internal use only*|
|NullToEmptyString|Yes|If a modification value is null, the parameter will receive an empty string instead|
|SecondaryManagerParameters|No|*Exchange specific - internal use only*|
|StringToCredential|Yes|A connection string in the form **user=*username*;password=*userpassword***; is converted to a [PSCredential](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.pscredential?view=PowerShellsdk-7.4.0) instance and passed to the parameter|
|StringToSecureString|Yes|A string is converted to a [SecureString](https://learn.microsoft.com/en-us/dotnet/api/system.security.securestring?view=net-8.0) instance and passed to the parameter|
|TicksToTimespanString|Yes|A long value containing the number of Ticks of a[Timespan](https://learn.microsoft.com/de-de/dotnet/api/system.timespan?view=net-8.0) is converted to the string representation. Sample: **72000000000** is converted to **'02:00:00'**|
|ZeroToNull|Yes|A **0** value is converted to **$null** and passed to the parameter|

###### The ReferenceTargets element
This element is used in conjunction with multi-valued attributes. The most common samples are member properties of groups. The synchronization engine needs to know the referenced types of the member property. In addition it needs to know the property of the referenced type that is stored as the reference value. 

A *ReferenceTarget* element has the following attributes:
|Attribute|Mandatory|Description|
|--|--|--|
|Class|Yes|The name of the [class](#the-class-element) that can be referenced.|
|Property|Yes|The name of the [property](#the-properties-element) in that class that is stored as a reference value.|

A member property can contain multiple reference targets. When the synchronization engine tries to resolve reference values (e.g. IDs) and load the references objects, it uses the order from the xml definition. In the following example, it would first try to find a user for a given ID, and then move on to groups.

 ```xml
<ReferenceTargets>
    <ReferenceTarget Class="User" Property="Id" />
    <ReferenceTarget Class="Group" Property="Id" />
</ReferenceTargets>
```

###### The ModifiedBy element
The *ModifiedBy* element defines, which command(s) actually update a property value in the target system during which [method](#the-methodconfiguration-element). It contains of 1..n *ModBy* items. This information is required because some [command mappings](#the-commandmappings-element) are used for other purposes like transferring an Id to a command that it requires to pick a particular object from the target system. The attributes of the *ModBy* element are as follows:

Attribute|Mandatory|Description|
|--|--|--|
|Command|Yes|The name of the command that updates the property value in the target system. This must either be a [CustomCommand](#customcommands) or a [PredefinedCommand](#predefinedcommands).|
|Method|No|The name of the modifying [method](#the-methodconfiguration-element).|

**Sample code**

The Set-User command is used in any modifying method (e.g. Insert and Update).
 ```xml
<ModifiedBy>
    <ModBy Command="Set-User" />
</ModifiedBy>
```

**Sample code**

The New-User command modifies the object during the "Insert" method, the Rename-User command during the "Update".
 ```xml
<ModifiedBy>
    <ModBy Command="New-User" Method="Insert" />
    <ModBy Command="Rename-User" Method="Update" />
</ModifiedBy></ModifiedBy>
```
##### The ReadConfiguration element
The *ReadConfiguration* element defines how to query objects from the target system. A *ReadConfiguration* element has two parts.

The **ListingCommand** is a [CustomCommand](#customcommands) or a [PredefinedCommand](#predefinedcommands) the loads all objects of the [class](#the-class-element) from the target system. It should ideally return all properties that are either:
- unique keys to identify object instances which can be used to individually reload objects (mandatory)
- all properties that are used as display values (optional but highly recommended)
- all properties that are required for object matching (optional but highly recommended)

If display and matching properties are not returned, the connector reloads each object individually during the object matching phase, which can have a serious impact on performance.

Attribute|Mandatory|Description|
|--|--|--|
|Command|Yes|The name of the command that returns the complete list of objects of the current [class](#the-class-element). This must either be a [CustomCommand](#customcommands) or a [PredefinedCommand](#predefinedcommands).|

In addition to the *ListingCommand*, a [command sequence](#command-sequences) to fully load an object from the target system is contained in the *ReadConfiguration* element.

 ```xml
<ReadConfiguration>
    <ListingCommand Command="List-Objects">
        <SetParameter Param="ObjectType" DataType="String" Source="FixedValue" Value="User" />
    </ListingCommand>
    <CommandSequence>
        <Item Command="Get-OneIMUser" Order="1" />
        <Item Command="Get-OneIMUserExtensionProperties" Order="2" />
    </CommandSequence>
</ReadConfiguration>
```
##### The MethodConfiguration element
The *MethodConfiguration* element specifies the  methods such as Insert, Update, Delete. You can also define custom methods that are made available in the synchronization editor later. Each method is represented by a *Method* element that has the following attributes:
The *MethodConfiguration* element specifies the methods such as Insert, Update, Delete. You can also define custom methods that are made available in the synchronization editor later. Each method is represented by a *Method* element that has the following attributes:

|Attribute|Mandatory|Description|
|--|--|--|
|Name|Yes|The name of the method.|
|IsObsolete|No|If set to **'true'** the synchronization engine will display the method type as obsolete. This can be useful if you plan to release a newer version of the connector definition that no longer supports this method.|

The method element consists of a [command sequence](#command-sequences) with all the commands required to fully complete the method. Multiple commandlet calls are possiblly required to fully update an object in the target system. To only call the commands were changes have been made, items in the [command sequences](#command-sequences) in method configurations have been given an additional attribute:

|Attribute|Mandatory|Description|
|--|--|--|
|Condition|No|Condition for running the method.<br/>**None** (Default): No condition - command will always be run<br/>**ModificationExists**: command is only run if at least one modification is present in the connector system object that is configured to be written by this command. This specified in the [ModifiedBy element](#the-modifiedby-element) of the corresponding [property](#the-properties-element).|

**Sample code**

Insert, Update, Delete method configurations.

 ```xml
<MethodConfiguration>
    <Method Name="Insert">
        <CommandSequence>
            <Item Command="New-Group" Order="1" />
            <Item Command="Test-OneIMGroupAvailable" Order="2" />
            <Item Command="Set-Group" Order="3" Condition="ModificationExists" />
            <Item Command="Set-SetOneIMGroupMembers" Order="4" Condition="ModificationExists">
        </CommandSequence>
    </Method>
    <Method Name="Update">
        <CommandSequence>
            <Item Command="Set-Group" Order="1" Condition="ModificationExists" />
            <Item Command="Set-SetOneIMGroupMembers" Order="2" Condition="ModificationExists"/>
        </CommandSequence>
    </Method>
    <Method Name="Delete">
        <CommandSequence>
            <Item Command="Remove-Group" Order="1">
                <SetParameter Param="Force" Source="SwitchParameter" Value="" />
            </Item>
        </CommandSequence>
    </Method>
</MethodConfiguration>
 ```
## Common concepts/deep dive

### Command sequences
Command sequences are used in several places in the definition. As the name implies, they are a list of commands that are run sequentially. For each command ,you can specify fixed parameters to be passed to the command. There are several sources available fFor the value of a parameter.

#### Command sequence item

The *CommandSequence* element contains of 1 to n *Item* elements that have the following attributes:

|Attribute|Mandatory|Description|
|--|--|--|
|Command|Yes|The name of the command to be called. This must be either a [CustomCommand](#customcommands) or a [PredefinedCommand](#predefinedcommands).|
|Order|Yes|This integer value defines the order that is used to call the commands in the sequence.|

**Sample code**

 ```xml
<CommandSequence>
    <Item Command="New-OneIMGroup" Order="1" />
    <Item Command="Set-OneIMGroupMember" Order="2" />
</CommandSequence>
```

#### SetParameter elements
To pass (default) parameters to a command, each *Item* element of a *CommandSequence* can contain multiple *SetParameter* elements. These parameters are passed to the command every time it is called no matter the context. Another way to dynamically set parameters is with [CommandMapping](#the-commandmappings-element). 

The *SetParameter* has the following attributes:

|Attribute|Mandatory|Description|
|--|--|--|
|Param|Yes|The name parameter to set|
|Source|Yes|The source of the value for the parameter. Permitted values are **ConnectionParameter**: passes the value of the [ConnectionParameter](#the-connectionparameters-element) specified in the *Value* attribute<br/> **FixedValue**: passes the value specified in the *Value* attribute<br/>**GlobalVariable**: passes the value of a global session variable having the name specified in the *Value* attribute. Note that **you must not** use the *global:* prefix<br/>**SwitchParameter**: activates the [SwitchParameter](https://learn.microsoft.com/en-us/PowerShell/module/microsoft.PowerShell.core/about/about_functions_advanced_parameters?view=PowerShell-7.4#switch-parameter-design-considerations) with the name specified in the *Param* attribute.<br/>**FixedArray**: passes the comma-separated values specified in the *Value* attribute as array.|
|Param|Yes|The value depending on the specified *Source* element.|
|DataType|No|Specify the DataType to which the *value* should be converted before it is passed to the command. Individual elements of arrays are converted. Permitted data types are **String** (default), **Int**, **Bool**, and **DateTime**.|
|ConversionMethod|No|A custom method implementation that converts the value. The only currently available method is **ToSecureString**, which creates a [SecureString](https://learn.microsoft.com/en-us/dotnet/api/system.security.securestring?view=net-8.0) instance with the contents provided by the parameter source. Specifying a conversion method will override the setting in the *DataType* attribute.|

**Sample code**

FixedValue source

 ```xml
<CommandSequence>
    <Item Command="New-User" Order="1">
        <SetParameter Param="LogLevel" Source="FixedValue" Value="Trace"/>
        <SetParameter Param="MaxLogHistory" Source="FixedValue" DataType="Int" Value="1024"/>
    </Item>
</CommandSequence>
```

**Sample code**

ConnectionParameter source

 ```xml
<CommandSequence>
    <Item Command="Connect-OneIMGraphInstance" Order="1">
        <SetParameter Param="Username" Source="ConnectionParameter" Value="Username" />
        <SetParameter Param="Password" Source="ConnectionParameter" Value="Password" ConversionMethod="ToSecureString"/>
    </Item>
</CommandSequence>
```

**Sample code**

GlobalVariable source

 ```xml
<CommandSequence>
    <Item Command="List-Object" Order="1">
        <SetParameter Param="Language" DataType="String" Source="GlobalVariable" Value="SessionLanguage"/>
    </Item>
</CommandSequence>
```

**Sample code**

SwitchParameter source (Recursive parameter is set to true)

 ```xml
<CommandSequence>
    <Item Command="Get-Folder" Order="1">
        <SetParameter Param="Recurse" Source="SwitchParameter" Value=""/>
    </Item>
</CommandSequence>
```

**Sample code**

FixedArray source

 ```xml
<CommandSequence>
    <Item Command="List-Object" Order="1">
        <SetParameter Param="ObjectTypesFilter" DataType="String" Source="FixedArray" Value="User,Group"/>
    </Item>
</CommandSequence>
```

### Custom commandlet to deal with multi-valued references (member properties)
A very common scenario is the synchronization and provisioning of membership type properties. As mentioned in [this section](#modify-data), these properties can be written in two modes.

#### Replace Modification
During a replace modification, all elements of the multi-valued reference are replaced with a new list of elements.

#### Add/Remove Modification (Modify)
Add or Remove modifications provide a way to modify a multi-valued property without replacing the full property contents. While not technically enforced, it is recommended that all connectors handle the following cases:

When a **Remove** modification is passed to the connector and the property value was already removed from the target or is not present due to other reasons, no error should be thrown. The modification must be handled as successful.

When an **Add** modification is passed to the connector and the property value is already present on the target, the operation is assumed to be successful.

The following [property](#the-properties-element) definition contains a [command mapping](#the-commandmappings-element) using the **CustomMVP** converter, required for this scenario:

 ```xml
<Property Name="Members" DataType="String" IsMultivalue="true">
    <ReferenceTargets>
        <ReferenceTarget Class="User" Property="Id" />
        <ReferenceTarget Class="Group" Property="Id" />
    </ReferenceTargets>
    <ReturnBindings>
        <Bind CommandResultOf="Get-OneIMGroupMember" Path="MemberIds" />
    </ReturnBindings>
    <ModifiedBy>
        <ModBy Command="Set-OneIMGroupMember" />
    </ModifiedBy>
    <CommandMappings>
        <Map ToCommand="Set-OneIMGroupMember" Converter="CustomMVP" />
    </CommandMappings>
</Property>
```

The custom commandlet **Set-OneIMGroupMember** has the following definition.

 ```xml
<CustomCommand Name="Set-OneIMGroupMember">
    <![CDATA[
    param (
        # The Id of the group that we want to add/remove/replace members to/from/of
        [parameter(Mandatory=$true,ValueFromPipelineByPropertyName=$true)]
        [ValidateNotNullOrEmpty()]
        [String]$GroupId,

        # parameter set by CustomMVP converter. Can be "MODIFY" or "REPLACE"
        [parameter(Mandatory=$false,ValueFromPipelineByPropertyName=$true)]
        [ValidateNotNullOrEmpty()]
        [String]$Mode,

        # parameter set by CustomMVP converter. Contains members to be added
        [parameter(Mandatory=$false,ValueFromPipelineByPropertyName=$true)]
        [String[]]$AddItems,

        # parameter set by CustomMVP converter. Contains members to be removed
        [parameter(Mandatory=$false,ValueFromPipelineByPropertyName=$true)]
        [String[]]$RemoveItems,

        # parameter set by CustomMVP converter. Contains a new member list
        [parameter(Mandatory=$false,ValueFromPipelineByPropertyName=$true)]
        [String[]]$ReplaceItems
    )
        # The implementation depends heavily on the target system API. In this sample code, we assume that we have the following
        # commandlets to modify the members:
        #     Add-OneIMGroupMember (adds a single member to the group)
        #     Remove-OneIMGroupMember (removes a single member from a group)
        #    Set-OneIMGroupMember (sets a new memberlist)
        
        # Get current members
        $allMembers = Get-OneIMGroupMember -Id $Id

        switch($mode.ToUpper())
        {
            "MODIFY" #add/remove
            {
                # only add items that are not already present
                if($AddItems -ne $null)
                {
                    foreach($add in $AddItems)
                    {
                        if($allMembers -notcontains $add)
                        {
                            Add-OneIMGroupMember -Id $Id -Member $add
                        }
                    }
                }

                # only remove items that are present
                if($RemoveItems -ne $null)
                {
                    foreach($remove in $RemoveItems)
                    {
                        if($allMembers -contains $remove)
                        {
                            Remove-OneIMGroupMember -Id $Id -Member $remove
                        }
                    }
                }
            }
            "REPLACE"
            {
                Set-OneIMGroupMember -Id $Id -Members $ReplaceItems
            }
            default
            {
                throw "Invalid mode $mode"
            }
        }        
    ]]>
</CustomCommand>
```

The **CustomMVP** converter operates as follows:

If the synchronization engine sends Add/Remove modifications, the converter passes the value **Modify** to the **Mode** parameter. Added items are passed in the **AddItems** parameter, removed items in the **RemoveItems** parameter.

If the synchronization engine sends a replace modification, the converter passes the value **Replace** to the **Mode** parameter. The replace values are passed to **ReplaceItems**.

If the synchronization engine sends a mix of **Add/Remove** and **Replace** modifications, the CustomMVP converter throws an Exception.

        Invalid modification. You can have multiple adds/removes OR a single replace modification

**Note**: The CustomMVP converter only supports properties of type **String**

## Best practices
The following sections list some best practices that have been developed during in-house connector development but also from customer feedback.

### Logging
You can use the OOTB Nlog logging capabilities of Identity Manager to write custom log messages from your [custom commandlets](#customcommands). Messages written to the internal PowerShell host will automatically be written to the configured log target (nlog.config) with the severity message prefix shown in the following table:

|Commandlet|Nlog Severity|Log message prefix|Remarks|
|--|--|--|--|
|Write-Verbose|Trace|*PowerShell [Verbose]>*||
|Write-Progress|Trace|*PowerShell [Progress]>*||
|Write-Debug|Debug|*PowerShell [Debug]>*||
|Write-Host|Info|*PowerShell [Regular]>* ||
|Write-Warning|Warning|*PowerShell [Warning]>*||
|Write-Error|Error|*PowerShell [Error]>*|Writing to the error stream also causes the command call to be evaluated as false. This adds an error in the pipeline run sequence which ultimately leads to an exception during evaluation by the connector.|

### Use SecureStrings
When passing parameters to [custom commandlets](#customcommands) use SecureString parameters to pass secret data such as passwords. Use the *ToSecureString* converter in your parameter mappings for this. SecureStrings are not visible in Trace logs.

**Sample code**

Pass a connection parameter as SecureString instance.
```xml
<CustomCommand Name="Connect-Session">
    <![CDATA[
    param(
        [String]$username,
        [SecureString]$password
    )
    ...
    ]]>
</CustomCommand>
...
<Connect>
    <CommandSequence>
        <Item Command="Connect-OneIMExchangeOnline" Order="1">
            <SetParameter Param="Username" Source="ConnectionParameter" Value="Username" />
            <SetParameter Param="Password" Source="ConnectionParameter" Value="Password" ConversionMethod="ToSecureString"/>
        </Item>
    </CommandSequence>
</Connect>
```
**Sample code**

Map a value to a commandlet and converting it to a secure string.
 ```xml
<CommandMappings>
    <Map ToCommand="Set-User" Parameter="Password" Converter="StringToSecureString" />
</CommandMappings>
```

**Sample code**

Shows how to encode/decode SecureStrings in your [custom commands](#customcommands).
 ```shell
# convert a string to SecureString
$secret = ConvertTo-SecureString -AsPlainText -Force -String "Hello World"

# PowerShell 6 - decode a SecureString
$decodedSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret))

# PowerShell 7 - decode a SecureString
$decodedSecret = ConvertFrom-SecureString -AsPlainText $secret
 ```

### Script modules vs. [Custom commandlets](#customcommands)
Instead of using a lot of custom commandlets directly embedded in the connector definition, you can consider putting the source in a [PowerShell scripting module](https://learn.microsoft.com/en-us/PowerShell/scripting/developer/module/how-to-write-a-PowerShell-script-module?view=PowerShell-7.4). While this approach is easier to debug, it make it harder to maintain access to this module from every Job server/admin client that requires the connection. To load your custom scripting module in the connector definition use the *Import-Module* command in your [connect](#environmentinitialization) routine. You also need to register the commandlets of your scripting module in the [predefined commands](#predefinedcommands) element.

**Sample code**

A scripting module in **C:\Test\SampleModule.psm1**.
```shell
<#
 #... header comments
#>
function Get-DatabaseUser 
{
    param(
        [string] $Id
    )
    Get-DatabaseRecords -Table "users" -Id $Id
}
<#
 #... header comments
#>
function Get-DatabaseGroup 
{
    param(
        [string] $Id
    )
    Get-DatabaseRecords -Table "groups" -Id $Id
}
<#
 #... header comments
#>
function List-DatabaseObjects
{
    param(
        [string] $table
    )
    Get-DatabaseRecords -Table $table
}

Export-ModuleMember -Function Get-DatabaseUser
Export-ModuleMember -Function Get-DatabaseGroup
Export-ModuleMember -Function List-DatabaseObjects
```

**Sample code**

Load the custom module in the connector definition while establishing the connection.
```xml
<ConnectionParameters>
    <ConnectionParameter Name="ModuleLocation" Description="Path to custom PowerShell module without the *.psm1 suffix e.g. C:\Test\SampleModule" />
    ...
</ConnectionParameters>
...
<EnvironmentInitialization>
    <Connect>
    <CommandSequence>
        <Item Command="Import-Module" Order="1">
            <SetParameter Param="Name" Source="ConnectionParameter" Value="ModuleLocation" />
        </Item>
    </CommandSequence>
    </Connect>
    ...
</EnvironmentInitialization> 
```

### Global variables (... and caching)
Global PowerShell variables will only be available in the current PowerShell session. Keep in mind that the PowerShell connector can spawn more than one of those sessions depending on the configuration. That also means that used global variables are not shared among those sessions. If you intend to use a global variable (e.g. for caching purposes), you need to keep this in mind.

**Sample code**

Custom commandlet with a very basic cache.
```xml
<CustomCommand Name="Get-User">
<![CDATA[
    param(
        [String]$Id
    )
    
    # check if cache exists
    if($global:UserCache -eq $null)
    {    
        Write-Host "Cache not yet initialized in this session, creating new instance"
        $global:UserCache = @{}
    }
    
    # try to get user from "cache"
    if($global:UserCache.ContainsKey($Id))
    {
        Write-Host "User with Id $Id found in cache"
        $usr = $global:UserCache[$Id]
    }
    else
    {
        Write-Host "User with Id $Id is loaded from system"
        $usr = Get-SystemUser -$Id
        if($usr -ne $null)
        {
            # store in cache
            $global:UserCache[$Id] = $usr
        }
        else
        {
            throw "User $Id not found"
        }
    }
    
    # output
    $usr
        
]]>
</CustomCommand>
```

## Sample connector
The sample connector accesses a Microsoft 365 environment using the [Microsoft Graph PowerShell Module](https://learn.microsoft.com/en-us/PowerShell/microsoftgraph/overview?view=graph-PowerShell-1.0). Since The PowerShell connector is often used to connect to webservice based systems, the sample connector uses the generic [Invoke-MgGraphRequest](https://learn.microsoft.com/en-us/PowerShell/module/microsoft.graph.authentication/invoke-mggraphrequest?view=graph-PowerShell-1.0) command for some operations. This is very similar to systems that you access with [Invoke-RestMethod](https://learn.microsoft.com/en-us/PowerShell/module/microsoft.PowerShell.utility/invoke-restmethod?view=PowerShell-7.4).
The demo definition supports users, groups, and membership of users in groups for a very limited set of properties.

### Prerequisites:

- To try the following sample connector yourself, you need a Microsoft Entra tenant. It is included in any Microsoft 365 subscription.
- Install the [Microsoft Graph PowerShell Module](https://learn.microsoft.com/en-us/PowerShell/microsoftgraph/overview?view=graph-PowerShell-1.0)
- To create a self-signed certificate and store it in the local user certificate store
    1. Ensure the *C:\Temp* directory exists (or else, modify the below script).
    2. Open an administrative PowerShell and run the following commands:
    ```shell
    $mycert = New-SelfSignedCertificate -DnsName "PowerShellSampleConnector" -CertStoreLocation "cert:\CurrentUser\My" -NotAfter (Get-Date).AddYears(10) -KeySpec KeyExchange
    $mycert | Export-Certificate -FilePath C:\Temp\ConnectorCertificate.cer
    $mycert | Export-PfxCertificate -FilePath C:\Temp\ConnectorCertificate.pfx -Password (ConvertTo-SecureString -AsPlainText -Force -String "yourCertPassword")
    ```   
    3. Navigate to *C:\Temp* and import the *ConnectorCertificate.pfx* into the certificate store of all computers that will run the connector (Jobservice, admin clients).

- Register an application to access the graph endpoint

    1. Go to the [Entra admin portal](https://entra.microsoft.com/#home).
    2. Navigate to [Applications / App registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade/quickStartType~/null/sourceType/Microsoft_AAD_IAM).
    3. Click on *New Registration*.
    4. Enter a name for your application (e.g. *Graph Connector PowerShell*).
    5. In the *Redirect URI (optional)* section choose *Public client/native desktop*.
    6. Click the *Register* button.
    7. **Copy the Application (client) ID** from the *Essentials* section. You will need that later.
    8. Go to the *Certificate and Secrets* section and upload the certificate (*.cer) created in the earlier step. After the upload, you can **copy the certificate thumbprint** from the table. You will need that later.
    9.  Go to the *API permissions* section and use *Add permission* to assign the following **Microsoft Graph** permissions of type **Application Permissions**:
        - *User.ReadWrite.All*
        - *Group.ReadWrite.All*
    10. Now click the *Grant admin consent for ...* button.
    

    **Optional**: If you want to reset (update) passwords, you need to add the applications service principal to the "Helpdesk Administrator" Entra role as follows:


    1. Navigate to the [Roles and Admins](https://entra.microsoft.com/#view/Microsoft_AAD_IAM/RolesManagementMenuBlade/~/AllRoles) section in the Entra portal.
    2. Add the **"Helpdesk Administrator"** role to your application (e.g. *Graph Connector PowerShell*). If your tenant uses PIM, make sure you create an active assignment.

    **Note:** If you want to add members to groups that are assignable to roles, instead of **"Helpdesk Administrator"**, assign the **"Global Administrator"** role. The sample connector cannot create such groups but you permission errors can occur if you try to add members to existing groups with this setting.

### XML Definition

```xml
<?xml version="1.0" encoding="utf-8" ?>
<PowershellConnectorDefinition Id="MGraph" Version="1.0" Description="Basic Microsoft Graph connector">
    
    <PluginAssemblies/>
    <ConnectionParameters>
        <ConnectionParameter Name="AppId" Description="Username for the Graph connection" />
        <ConnectionParameter Name="CertificateThumbprint" Description="Thumbprint of the connection certificate. This needs to be installed in your local users certificate store" IsSensibleData="true"/>
        <ConnectionParameter Name="TenantId" Description="Guid or *.onmicrosoft.com domain of the tenant." />
    </ConnectionParameters>
    <Initialization>
        <CustomCommands>
            
            <!--Checks, if Graph PowerShell module is installed and outputs version to Nlog-->
            <CustomCommand Name="Check-OneIMGraphModuleAvailable">
            <![CDATA[
                $gmod = Get-Module Microsoft.Graph -ListAvailable
                if($gmod -ne $null)
                {
                    Write-Host "Graph Module Version: $($gmod.Version.ToString())"
                } else
                {
                    throw "Microsoft.Graph PowerShell module is not installed"
                }
            ]]>                
            </CustomCommand>

            <!--Wrapper for Connect-MGraph-->
            <CustomCommand Name="Connect-OneIMGraph">
            <![CDATA[
                param(
                    [String]$AppId,
                    [String]$CertificateThumbprint,
                    [String]$TenantId
                )
                
                #Connect
                Connect-MgGraph -TenantId $TenantId -AppId $AppId -CertificateThumbprint $CertificateThumbprint
                
                # Log the Graph Context
                # We don't want to have any return value from this function call but just log
                # the context to the host. To achieve this we need to ...
                # 1. pipe the $ctx object to the desired formatting function (here, Format-Text)
                # 2. then pipe this output to the Out-String function that converts it to text
                # 3. and finally write it to the host using Write-Host
                
                $ctx = Get-MgContext
                $ctx | Format-List | Out-String | Write-Host
            ]]>                
            </CustomCommand>            
            
            <!--Custom implementation for Get-MgGroup to illustrate handling of service calls -->
            <CustomCommand Name="Get-OneIMGroup">
            <![CDATA[
                param(
                    [String]$Id,
                    [String[]]$PropertiesToRequest
                )
                
                # if $Id parameter was specified, load the individual group
                # otherwise, load all groups. Note there is a dedicated commandlet for fetching groups available
                # but for DEMONSTRATION PURPOSES we will use Invoke-MgGraphRequest here since it is similar to Invoke-RestRequest
                # NOTE:
                #     This call does not do any paging and will only return the first result "page"
                #    This sample code contains no to few checks (e.g. return value types etc.) make sure to extend those in production code
                
                $selectList = "Displayname,Id"
                if($PSBoundParameters.ContainsKey("PropertiesToRequest"))
                {
                    $selectList = $PropertiesToRequest -join ","
                }
    
                if($PSBoundParameters.ContainsKey("Id"))
                {
                    Write-Host "Loading group object with ID $($Id)"
                    $jsonResult = Invoke-MgGraphRequest -Uri https://graph.microsoft.com/v1.0/groups/$($Id)?select=$($selectList) -Method GET -OutputType Json
                    
                }
                else
                {
                    Write-Host "Loading groups"
                    $jsonResult = Invoke-MgGraphRequest -Uri https://graph.microsoft.com/v1.0/groups?select=$($selectList) -Method GET -OutputType Json
                }

                $psObj = ConvertFrom-JSon $jsonResult
                
                # Ensure PSObjects have all requested properties even if they are null
                $retVal = $null;
                
                # List has a "value" property
                if (Get-Member -InputObject $psObj -name "Value" -Membertype Properties)
                {
                    $retVal = @()
                    Write-Host "Normalize objects"
                    foreach($v in $psObj.Value)
                    {
                        $retVal += Ensure-OneIMPropertiesOfJsonResultObject -Object $v -Properties $PropertiesToRequest
                    }
                }
                else
                {
                    Write-Host "Normalize object"
                    $retVal = Ensure-OneIMPropertiesOfJsonResultObject -Object $psObj -Properties $PropertiesToRequest
                }

                Write-Output $retVal
            ]]>            
            </CustomCommand>
            
            <!--Custom implementation for New-MgGroup to illustrate handling of service calls-->
            <CustomCommand Name="New-OneIMGroup">
            <![CDATA[
                param(
                    [Parameter(Mandatory=$true)]
                    [string]$DisplayName,
                    
                    [string]$Description,
                    
                    [string[]]$groupTypes,
                    
                    [string]$mail,
                    
                    [string]$MailnickName,
                    
                    [Parameter(Mandatory=$true)]
                    [boolean]$SecurityEnabled = $false,
                    
                    [Parameter(Mandatory=$true)]
                    [boolean]$MailEnabled = $false
                )
                
                $bodyData = @{}
                if($PSBoundParameters.ContainsKey("DisplayName") -and $DisplayName -ne "")
                {
                    $bodyData["DisplayName"] = $DisplayName
                }
                if($PSBoundParameters.ContainsKey("Description") -and $Description -ne "")
                {
                    $bodyData["Description"] = $Description
                }
                if($PSBoundParameters.ContainsKey("groupTypes"))
                {
                    $bodyData["groupTypes"] = $groupTypes
                }
                if($PSBoundParameters.ContainsKey("mail") -and $mail -ne "")
                {
                    $bodyData["mail"] = $mail
                }
                if($PSBoundParameters.ContainsKey("MailnickName") -and $MailnickName -ne "")
                {
                    $bodyData["MailnickName"] = $MailnickName
                }
                if($PSBoundParameters.ContainsKey("SecurityEnabled"))
                {
                    $bodyData["SecurityEnabled"] = $SecurityEnabled
                }
                if($PSBoundParameters.ContainsKey("MailEnabled"))
                {
                    $bodyData["MailEnabled"] = $MailEnabled
                }
                $body = ConvertTo-Json $bodyData
                
                $jsonResult = Invoke-MgGraphRequest -Uri https://graph.microsoft.com/v1.0/groups -Body $body -Method POST -OutputType Json
                $psObj = ConvertFrom-JSon $jsonResult
                $retVal = Ensure-OneIMPropertiesOfJsonResultObject -Object $psObj -Properties Id,DisplayName,Description
                Write-Output $retval
            ]]>                
            </CustomCommand>

            <!--
                Custom commandlet to update group members. Parameters (except "Id") are
                set by the CustomMVP converter used in the CommandMapping to this command
                (see "Members" property of the "Group" class)
            -->
            <CustomCommand Name="Set-OneIMGroupMember">
                <![CDATA[
                param (
                    # The Id of the group that we want to add/remove/replace members to/from/of
                    [parameter(Mandatory=$true,ValueFromPipelineByPropertyName=$true)]
                    [ValidateNotNullOrEmpty()]
                    [String]$Id,

                    # parameter set by CustomMVP converter. Can be "MODIFY" or "REPLACE"
                    [parameter(Mandatory=$false,ValueFromPipelineByPropertyName=$true)]
                    [ValidateNotNullOrEmpty()]
                    [String]$Mode,

                    # parameter set by CustomMVP converter. Contains members to be added
                    [parameter(Mandatory=$false,ValueFromPipelineByPropertyName=$true)]
                    [String[]]$AddItems,

                    # parameter set by CustomMVP converter. Contains members to be removed
                    [parameter(Mandatory=$false,ValueFromPipelineByPropertyName=$true)]
                    [String[]]$RemoveItems,

                    # parameter set by CustomMVP converter. Contains a new member list
                    [parameter(Mandatory=$false,ValueFromPipelineByPropertyName=$true)]
                    [String[]]$ReplaceItems
                )
                    # Get current members (using our own cmdlet)
                    $allMemberObj = Get-OneIMGroupMember -Id $Id
                    $allMembers = $allMemberObj.MemberIds

                    switch($mode.ToUpper())
                    {
                        "MODIFY" #add/remove
                        {
                            # only add items that are not already present
                            if($AddItems -ne $null)
                            {
                                foreach($add in $AddItems)
                                {
                                    if($allMembers -notcontains $add)
                                    {
                                        New-MgGroupMember -GroupId $Id -DirectoryObjectId $add
                                    }
                                }
                            }

                            # only remove items that are present
                            if($RemoveItems -ne $null)
                            {
                                foreach($remove in $RemoveItems)
                                {
                                    if($allMembers -contains $remove)
                                    {
                                        Remove-MgGroupMemberByRef -GroupId $Id -DirectoryObjectId $remove
                                    }
                                }
                            }
                        }
                        "REPLACE"
                        {
                            # Since there is not commandlet to update (replace) the entire grouplist, we need to send a
                            # series of add/removes
                            
                            #remove all current members that are not in the new memberlist
                            foreach( $rem in $($allMembers | ?{ $ReplaceItems -notcontains $_ }))
                            {
                                Remove-MgGroupMemberByRef -GroupId $Id -DirectoryObjectId $rem
                            }
                            
                            #add all members of the replacelist that were not already member of the group
                            foreach( $add in $($ReplaceItems | ?{ $allMembers -notcontains $_ }))
                            {
                                New-MgGroupMember -GroupId $Id -DirectoryObjectId $add
                            }                            
                        }
                        default
                        {
                            throw "Invalid mode $mode"
                        }
                    }        
                ]]>        
            </CustomCommand>
            
            <!--
                Transform the result of Get-MgGroupMember to a PSObject having one mutli-valued 
                property having containing the Ids of the members
            -->
            <CustomCommand Name="Get-OneIMGroupMember">
            <![CDATA[
                param(
                    [String]$Id
                )
                
                $members = Get-MgGroupMember -GroupId $Id -All
                $memberIds = @()
                foreach($m in $members)
                {
                    $memberIds += $m.Id
                }
                $retVal = New-Object PSObject -Property @{ MemberIds = $memberIds}                
                Write-Output $retVal
            ]]>            
            </CustomCommand>            

            <!--
                We need a wrapper for New-MgUser since we need to create a passwordProfile parameter which
                cannot (yet) be achieved ootb
            -->
            <CustomCommand Name="New-OneIMUser">
            <![CDATA[
                param(
                    [Parameter(Mandatory=$true)]
                    [string]$DisplayName,
                    
                    [SecureString]$Password,
                    
                    [boolean]$accountEnabled=$false,
                    
                    [Parameter(Mandatory=$true)]
                    [string]$MailnickName,
                    
                    [Parameter(Mandatory=$true)]
                    [string]$UserPrincipalName
                )
                
                #use parameter splatting https://learn.microsoft.com/en-us/PowerShell/module/microsoft.PowerShell.core/about/about_splatting?view=PowerShell-7.4
                $parms = @{
                    DisplayName = $DisplayName
                    AccountEnabled = $accountEnabled
                    MailnickName = $MailnickName
                    UserPrincipalName = $UserPrincipalName
                }
                
                #construct passwordProfile parameter
                
                # ... decode securestring (beginning in PowerShell 7 (.NET Core) there is a ConverFrom-SecureString commandlet is available)
                $decodedPwd = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password))
                
                # ... create passwordProfile with decoded value
                $PasswordProfile = @{
                    Password = $decodedPwd
                }
                
                # ... and add it to the parameter hashtable
                $parms["PasswordProfile"] = $PasswordProfile

                # call New-MgUser, capture the returned user object
                $user = New-MgUser @parms
                
                # and write it to the output stream by just outputting the variable
                # instead this, you can also...
                # ... NOT capture the output that will automatically write the return value to the output stream
                # ... explicitly call Write-Output $user
                
                $user
            ]]>                
            </CustomCommand>

            <!--
                Set password when updating a user
            -->
            <CustomCommand Name="Set-OneIMUserPassword">
            <![CDATA[
                param(
                    [Parameter(Mandatory=$true)]
                    [string]$Id,
                    
                    [SecureString]$Password
                )
                
                #construct passwordProfile parameter
                
                # ... decode securestring (beginning in PowerShell 7 (.NET Core) there is a ConverFrom-SecureString commandlet is available)
                $decodedPwd = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password))
                
                # ... create passwordProfile with decoded value
                $PasswordProfile = @{
                    Password = $decodedPwd
                }
                
                Update-MgUser -UserId $Id -PasswordProfile $PasswordProfile
            ]]>                
            </CustomCommand>

            <!--
                Utility function to ensure all requested properties are present in the returned object.
                This will prevent "No Property ... found." exceptions that are thrown due to null values in json
            -->
            <CustomCommand Name="Ensure-OneIMPropertiesOfJsonResultObject">
            <![CDATA[
                param(
                    [PSObject]$Object,
                    [String[]]$Properties
                )
                
                foreach($prop in $Properties)
                {
                    if (-not (Get-Member -InputObject $Object -name $prop -Membertype Properties)) 
                    {
                        Write-Host "Adding property $prop with value $null to object instance"
                        Add-Member -InputObject $Object -NotePropertyName $prop -NotePropertyValue $null
                    }
                }
                Write-Output $Object
            ]]>                
            </CustomCommand>
        </CustomCommands>
        
        <PredefinedCommands>
            <Command Name="Disconnect-MgGraph" />
            <Command Name="Get-MgUser" />
            <Command Name="Update-MgUser" />
            <Command Name="Remove-MgUser" />
            <Command Name="Update-MgGroup" />
            <Command Name="Remove-MgGroup" />
        </PredefinedCommands>
        
        <EnvironmentInitialization>
            <Connect>
                <CommandSequence>
                    <Item Command="Check-OneIMGraphModuleAvailable" Order="1"/>
                    <Item Command="Connect-OneIMGraph" Order="2">
                        <SetParameter Param="AppId" Source="ConnectionParameter" Value="AppId" />
                        <SetParameter Param="CertificateThumbprint" Source="ConnectionParameter" Value="CertificateThumbprint" />
                        <SetParameter Param="TenantId" Source="ConnectionParameter" Value="TenantId" />
                    </Item>
                </CommandSequence>
            </Connect>
            <Disconnect>
                <CommandSequence>
                    <Item Command="Disconnect-MgGraph" Order="1"/>
                </CommandSequence>
            </Disconnect>            
        </EnvironmentInitialization>
        
    </Initialization>
    <Schema>

        <Class Name="User" Description="Entra Groups">
            <Properties>

                <Property Name="Id" DataType="String" IsMandatory="true" IsUniqueKey="true" AccessConstraint="ReadAndInsertOnly">
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-MgUser" Path="Id"/>
                        <Bind CommandResultOf="New-OneIMUser" Path="Id"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="Get-MgUser" Parameter="UserId"/>
                        <Map ToCommand="Update-MgUser" Parameter="UserId"/>
                        <Map ToCommand="Set-OneIMUserPassword" Parameter="Id"/>
                        <Map ToCommand="Remove-MgUser" Parameter="UserId"/>
                    </CommandMappings>                    
                </Property>

                <Property Name="DisplayName" DataType="String" IsDisplay="true" IsMandatory="true">
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-MgUser" Path="DisplayName"/>
                        <Bind CommandResultOf="New-OneIMUser" Path="DisplayName"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="New-OneIMUser" Parameter="DisplayName"/>
                        <Map ToCommand="Update-MgUser" Parameter="DisplayName"/>
                    </CommandMappings>
                    <ModifiedBy>
                        <ModBy Command="Update-MgUser" />
                    </ModifiedBy>                    
                </Property>
                
                <Property Name="UsageLocation" DataType="String" >
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-MgUser" Path="UsageLocation"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="Update-MgUser" Parameter="UsageLocation"/>
                    </CommandMappings>
                    <ModifiedBy>
                        <ModBy Command="Update-MgUser" />
                    </ModifiedBy>                    
                </Property>
                
                <Property Name="UserPrincipalName" DataType="String" IsMandatory="true">
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-MgUser" Path="UserPrincipalName"/>
                        <Bind CommandResultOf="New-OneIMUser" Path="UserPrincipalName"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="New-OneIMUser" Parameter="UserPrincipalName"/>
                        <Map ToCommand="Update-MgUser" Parameter="UserPrincipalName"/>
                    </CommandMappings>
                    <ModifiedBy>
                        <ModBy Command="Update-MgUser" />
                    </ModifiedBy>                    
                </Property>                
                
                <Property Name="Mail" DataType="String" AccessConstraint="ReadOnly">
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-MgUser" Path="Mail"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="Update-MgUser" Parameter="Mail"/>
                    </CommandMappings>
                    <ModifiedBy>
                        <ModBy Command="Update-MgUser" />
                    </ModifiedBy>                        
                </Property>
                
                <Property Name="Surname" DataType="String" >
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-MgUser" Path="Surname"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="Update-MgUser" Parameter="Surname"/>
                    </CommandMappings>
                    <ModifiedBy>
                        <ModBy Command="Update-MgUser" />
                    </ModifiedBy>                    
                </Property>
                
                <Property Name="GivenName" DataType="String" >
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-MgUser" Path="GivenName"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="Update-MgUser" Parameter="GivenName"/>
                    </CommandMappings>
                    <ModifiedBy>
                        <ModBy Command="Update-MgUser" />
                    </ModifiedBy>                    
                </Property>

                <Property Name="AccountEnabled" DataType="Bool" >
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-MgUser" Path="AccountEnabled"/>
                        <Bind CommandResultOf="New-OneIMUser" Path="AccountEnabled"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="New-OneIMUser" Parameter="AccountEnabled"/>
                        <Map ToCommand="Update-MgUser" Parameter="AccountEnabled"/>
                    </CommandMappings>
                    <ModifiedBy>
                        <ModBy Command="Update-MgUser" />
                    </ModifiedBy>                    
                </Property>                
                
                <!--
                    Since we cannot read passwords, the AccessConstraint is "WriteOnly".
                    The property is also marked as IsSecret which will cause it not to be written in any logs
                -->
                <Property Name="Pasword" DataType="String" IsSecret="true" AccessConstraint="WriteOnly" >
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-MgUser" Path="AccountEnabled"/>
                        <Bind CommandResultOf="New-OneIMUser" Path="AccountEnabled"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <!--
                            Since we need to implement custom commandlets because of the way passwords are set any
                            way, we can also transfer them as SecureStrings using the StringToSecureString converter.
                            Check the custom commandlets to see, how those strings are decoded for further use.
                        -->
                        <Map ToCommand="New-OneIMUser" Parameter="Password" Converter="StringToSecureString" />
                        <Map ToCommand="Set-OneIMUserPassword" Parameter="Password" Converter="StringToSecureString" />
                    </CommandMappings>
                    <ModifiedBy>
                        <ModBy Command="Set-OneIMUserPassword" />
                    </ModifiedBy>                    
                </Property>
                
                <Property Name="MailnickName" DataType="String" IsMandatory="true" >
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-MgUser" Path="MailnickName"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="New-OneIMUser" Parameter="MailnickName"/>
                        <Map ToCommand="Update-MgUser" Parameter="MailnickName"/>
                    </CommandMappings>
                    <ModifiedBy>
                        <ModBy Command="Update-MgUser" />
                    </ModifiedBy>                    
                </Property>                
                
            </Properties>    

            <ReadConfiguration>
                <ListingCommand Command="Get-MgUser">
                    <SetParameter Param="All" Source="SwitchParameter" Value="" />
                    <!--Only request id, display and mapping relevant properties-->
                    <SetParameter Param="Property" Source="FixedArray" Value="DisplayName,Id" />
                </ListingCommand>
                <CommandSequence>
                    <Item Command="Get-MgUser" Order="1">
                        <!--request all properties we want to support for the user class that are returned by Get-MgUser-->
                        <SetParameter Param="Property" Source="FixedArray" Value="DisplayName,Id,UsageLocation,Mail,UserPrincipalName,Surname,GivenName,AccountEnabled,MailnickName" />
                    </Item>
                </CommandSequence>
            </ReadConfiguration>

            <MethodConfiguration>
                <Method Name="Insert">
                    <CommandSequence>
                        <Item Command="New-OneIMUser" Order="1" />
                        <Item Command="Update-MgUser" Order="2" />
                    </CommandSequence>
                </Method>
                
                <Method Name="Update">
                    <!-- 
                        The 'ModificationExists' causes that the command is only executed, if
                        at least one property was changed that was marked to be modified by the specific command
                    -->
                    <CommandSequence>
                        <Item Command="Set-OneIMUserPassword" Order="1" Condition="ModificationExists" />
                        <Item Command="Update-MgUser" Order="2" Condition="ModificationExists" />
                    </CommandSequence>
                </Method>
                
                <Method Name="Delete">
                    <CommandSequence>
                        <Item Command="Remove-MgUser" Order="1" />
                    </CommandSequence>
                </Method>
                
            </MethodConfiguration>
        </Class>
        
        <Class Name="Group" Description="Entra Groups">
            <Properties>

                <Property Name="Id" DataType="String" IsMandatory="true" IsUniqueKey="true" AccessConstraint="ReadAndInsertOnly">
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-OneIMGroup" Path="Id"/>
                        <Bind CommandResultOf="New-OneIMGroup" Path="Id"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="Get-OneIMGroup" Parameter="Id"/>
                        <Map ToCommand="Get-OneIMGroupMember" Parameter="Id"/>
                        <Map ToCommand="Update-MgGroup" Parameter="GroupId"/>
                        <Map ToCommand="Set-OneIMGroupMember" Parameter="Id"/>
                        <Map ToCommand="Remove-MgGroup" Parameter="GroupId"/>                        
                    </CommandMappings>                    
                </Property>

                <Property Name="DisplayName" DataType="String" IsDisplay="true" IsMandatory="true">
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-OneIMGroup" Path="DisplayName"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="New-OneIMGroup" Parameter="DisplayName"/>
                        <Map ToCommand="Update-MgGroup" Parameter="DisplayName"/>
                    </CommandMappings>
                    <ModifiedBy>
                        <ModBy Command="Update-MgGroup" />
                    </ModifiedBy>                    
                </Property>

                <Property Name="Description" DataType="String" >
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-OneIMGroup" Path="Description"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="New-OneIMGroup" Parameter="Description"/>
                        <Map ToCommand="Update-MgGroup" Parameter="Description"/>
                    </CommandMappings>
                    <ModifiedBy>
                        <ModBy Command="Update-MgGroup" />
                    </ModifiedBy>                    
                </Property>
                
                <Property Name="GroupTypes" DataType="String" IsMultivalue="true" AccessConstraint="None">
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-OneIMGroup" Path="GroupTypes"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="New-OneIMGroup" Parameter="GroupTypes"/>
                    </CommandMappings>                    
                </Property>                
                
                <Property Name="Mail" DataType="String" AccessConstraint="ReadOnly" >
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-OneIMGroup" Path="Mail"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="New-OneIMGroup" Parameter="Mail"/>
                    </CommandMappings>
                </Property>
                
                <Property Name="MailnickName" DataType="String" IsMandatory="true">
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-OneIMGroup" Path="MailnickName"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="New-OneIMGroup" Parameter="MailnickName"/>
                        <Map ToCommand="Update-MgGroup" Parameter="MailnickName"/>
                    </CommandMappings>
                    <ModifiedBy>
                        <ModBy Command="Update-MgGroup" />
                    </ModifiedBy>                    
                </Property>    

                <Property Name="MailEnabled" DataType="Bool" AccessConstraint="ReadAndInsertOnly">
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-OneIMGroup" Path="MailEnabled"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="New-OneIMGroup" Parameter="MailEnabled"/>
                    </CommandMappings>                    
                </Property>                    

                <Property Name="SecurityEnabled" DataType="Bool" AccessConstraint="ReadAndInsertOnly">
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-OneIMGroup" Path="SecurityEnabled"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <Map ToCommand="New-OneIMGroup" Parameter="SecurityEnabled"/>
                    </CommandMappings>
                </Property>    

                <Property Name="Members" DataType="String" IsMultivalue="true" >
                    <ReferenceTargets>
                        <ReferenceTarget Class="User" Property="Id" />
                        <ReferenceTarget Class="Group" Property="Id" />
                    </ReferenceTargets>                
                    <ReturnBindings>
                        <Bind CommandResultOf="Get-OneIMGroupMember" Path="MemberIds"/>
                    </ReturnBindings>
                    <CommandMappings>
                        <!--Use the customMVP converter that will automatically populate the corresponding parameters of Set-OneIMGroupMember-->
                        <Map ToCommand="Set-OneIMGroupMember" Converter="CustomMvp" />
                    </CommandMappings>
                    <ModifiedBy>
                        <ModBy Command="Set-OneIMGroupMember" />
                    </ModifiedBy>                    
                </Property>                
                
            </Properties>            
            
            <ReadConfiguration>
                <ListingCommand Command="Get-OneIMGroup">
                    <!--Only request id, display and mapping relevant properties-->
                    <SetParameter Param="PropertiesToRequest" Source="FixedArray" Value="DisplayName,Id,MailnickName" />
                </ListingCommand>
                <CommandSequence>
                    <Item Command="Get-OneIMGroup" Order="1">
                        <!--request all properties we want to support-->
                        <SetParameter Param="PropertiesToRequest" Source="FixedArray" Value="DisplayName,Description,groupTypes,Id,mail,MailnickName,SecurityEnabled,MailEnabled" />
                    </Item>
                    <Item Command="Get-OneIMGroupMember" Order="2" />
                </CommandSequence>
            </ReadConfiguration>

            <MethodConfiguration>
            
                <Method Name="Insert">
                    <CommandSequence>
                        <Item Command="New-OneIMGroup" Order="1" />
                        <Item Command="Set-OneIMGroupMember" Order="2" />
                    </CommandSequence>
                </Method>
                
                <Method Name="Update">
                    <CommandSequence>
                        <Item Command="Update-MgGroup" Order="1" Condition="ModificationExists"/>
                        <Item Command="Set-OneIMGroupMember" Order="2" Condition="ModificationExists"/>
                    </CommandSequence>
                </Method>
                
                <Method Name="Delete">
                    <CommandSequence>
                        <Item Command="Remove-MgGroup" Order="1"/>
                    </CommandSequence>
                </Method>
                
            </MethodConfiguration>            
        </Class>
    </Schema>
</PowershellConnectorDefinition>
``` 

<!-- LICENSE -->
# License

Distributed under the One Identity - Open Source License. See [LICENSE](LICENSE) for more information.
